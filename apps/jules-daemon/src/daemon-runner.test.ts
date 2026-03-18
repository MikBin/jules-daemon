import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DaemonRunner } from "./daemon-runner.js";
import { Database } from "./db/database.js";
import type { JulesApiClient } from "./api/jules-api-client.js";
import { SessionMonitor } from "./monitor/session-monitor.js";
import { EventRouter } from "./monitor/event-router.js";
import { TaskDispatcher } from "./scheduler/task-dispatcher.js";
import { CompletionHandler } from "./scheduler/completion-handler.js";

// Mocks
vi.mock("./monitor/session-monitor.js");
vi.mock("./monitor/event-router.js");
vi.mock("./scheduler/task-dispatcher.js");
vi.mock("./scheduler/completion-handler.js");

describe("DaemonRunner", () => {
  let db: Database;
  let api: JulesApiClient;
  let runner: DaemonRunner;
  let mockClock: () => string;

  beforeEach(async () => {
    vi.useFakeTimers();
    db = await Database.open(":memory:");
    vi.spyOn(db, "save");

    api = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      approvePlan: vi.fn(),
      sendMessage: vi.fn(),
      extractPr: vi.fn(),
    };

    mockClock = () => "2024-01-01T00:00:00.000Z";

    // reset mocks before each test
    vi.clearAllMocks();

    runner = new DaemonRunner(db, api, {
      pollIntervalMs: 1000,
      saveIntervalMs: 5000,
      clock: mockClock,
    });
  });

  afterEach(() => {
    runner.stop();
    vi.useRealTimers();
  });

  it("should initialize components and start loops on start()", () => {
    expect(runner.running).toBe(false);

    runner.start();

    expect(runner.running).toBe(true);

    // Verify dependencies were instantiated
    expect(SessionMonitor).toHaveBeenCalledWith(db, api, mockClock, { stuckMinutes: undefined });
    expect(TaskDispatcher).toHaveBeenCalledWith(db, api, expect.any(SessionMonitor), mockClock, { maxParallelGlobal: undefined });
    expect(CompletionHandler).toHaveBeenCalledWith(db, expect.any(TaskDispatcher), mockClock);
    expect(EventRouter).toHaveBeenCalledWith(db, mockClock, expect.any(CompletionHandler));

    // Verify calling start() again doesn't crash or re-init
    runner.start();
    expect(SessionMonitor).toHaveBeenCalledTimes(1);
  });

  it("should run tick sequence in order", async () => {
    runner.start();

    // The instances are mocked so we can grab the methods
    const mockMonitor = vi.mocked(SessionMonitor).mock.instances[0];
    const mockRouter = vi.mocked(EventRouter).mock.instances[0];
    const mockDispatcher = vi.mocked(TaskDispatcher).mock.instances[0];

    // Spy on the methods
    const pollAllSpy = vi.spyOn(mockMonitor, "pollAll").mockResolvedValue();
    const routeAllSpy = vi.spyOn(mockRouter, "routeAll").mockResolvedValue(0);
    const dispatchAllSpy = vi.spyOn(mockDispatcher, "dispatchAll").mockResolvedValue({ dispatched: [], errors: [] });

    await runner.tick();

    // Verify all steps were called
    expect(pollAllSpy).toHaveBeenCalledTimes(1);
    expect(routeAllSpy).toHaveBeenCalledTimes(1);
    expect(dispatchAllSpy).toHaveBeenCalledTimes(1);

    // Sequence check: order of calls is deterministic given async sequence
    const pollOrder = pollAllSpy.mock.invocationCallOrder[0];
    const routeOrder = routeAllSpy.mock.invocationCallOrder[0];
    const dispatchOrder = dispatchAllSpy.mock.invocationCallOrder[0];

    expect(pollOrder).toBeLessThan(routeOrder);
    expect(routeOrder).toBeLessThan(dispatchOrder);
  });

  it("should ignore tick() if not running", async () => {
    // Note: runner.start() is NOT called

    // We can't access instances directly since start() wasn't called,
    // so we just ensure tick doesn't throw or do anything.
    await expect(runner.tick()).resolves.toBeUndefined();
  });

  it("should execute tick automatically on poll interval", async () => {
    runner.start();
    const mockMonitor = vi.mocked(SessionMonitor).mock.instances[0];
    const pollAllSpy = vi.spyOn(mockMonitor, "pollAll").mockResolvedValue();

    expect(pollAllSpy).not.toHaveBeenCalled();

    // Advance time by poll interval
    await vi.advanceTimersByTimeAsync(1000);

    expect(pollAllSpy).toHaveBeenCalledTimes(1);
  });

  it("should save db automatically on save interval", async () => {
    runner.start();

    expect(db.save).not.toHaveBeenCalled();

    // Advance time by save interval
    await vi.advanceTimersByTimeAsync(5000);

    expect(db.save).toHaveBeenCalledTimes(1);
  });

  it("should flush db and clear intervals on stop()", () => {
    runner.start();
    expect(runner.running).toBe(true);
    expect(db.save).not.toHaveBeenCalled();

    runner.stop();

    expect(runner.running).toBe(false);
    expect(db.save).toHaveBeenCalledTimes(1);

    // Verify calling stop() again doesn't crash or double save
    runner.stop();
    expect(db.save).toHaveBeenCalledTimes(1);
  });

  it("should log errors and continue if tick step throws", async () => {
    runner.start();
    const mockMonitor = vi.mocked(SessionMonitor).mock.instances[0];
    const pollAllSpy = vi.spyOn(mockMonitor, "pollAll").mockRejectedValue(new Error("Network error"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runner.tick();

    expect(pollAllSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith("DaemonRunner tick error:", expect.any(Error));

    consoleErrorSpy.mockRestore();
  });
});
