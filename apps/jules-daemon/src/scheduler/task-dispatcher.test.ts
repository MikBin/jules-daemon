import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TaskDispatcher, type DispatcherConfig } from "./task-dispatcher.js";
import { Database } from "../db/database.js";
import { SessionMonitor } from "../monitor/session-monitor.js";
import type { JulesApiClient } from "../api/jules-api-client.js";
import type { JulesSession } from "@jules-daemon/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = "2026-03-18T09:00:00.000Z";
const T1 = "2026-03-18T09:01:00.000Z";

let sessionCounter = 0;

function makeApi(options?: { failForTasks?: string[] }): JulesApiClient {
  return {
    createSession: async (params) => {
      if (options?.failForTasks?.some((t) => params.prompt.includes(t))) {
        throw new Error("API error");
      }
      return `sessions/${++sessionCounter}`;
    },
    getSession: async (id) => ({ session_id: id, state: "STARTING" }),
    approvePlan: async () => {},
    sendMessage: async () => {},
    extractPr: async () => null,
  };
}

function seedStoryWithTasks(
  db: Database,
  tasks: Array<{
    task_id: string;
    status?: string;
    session_id?: string;
    prompt?: string;
    deps?: string[];
  }>,
  storyId = "s1",
) {
  db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: T0 });
  db.insertStory({ story_id: storyId, project_id: "p1", status: "OPEN", created_at: T0, updated_at: T0 });

  for (const t of tasks) {
    db.insertTask({
      task_id: t.task_id,
      story_id: storyId,
      project_id: "p1",
      owner_agent_id: "a1",
      title: `Task ${t.task_id}`,
      prompt: t.prompt ?? `Do ${t.task_id}`,
      status: t.status ?? "PENDING",
      session_id: t.session_id ?? null,
      created_at: T0,
      updated_at: T0,
    });
    for (const dep of t.deps ?? []) {
      db.addTaskDependency(t.task_id, dep);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskDispatcher", () => {
  let db: Database;
  let api: JulesApiClient;
  let monitor: SessionMonitor;
  let dispatcher: TaskDispatcher;

  beforeEach(async () => {
    sessionCounter = 0;
    db = await Database.open(":memory:");
    api = makeApi();
    monitor = new SessionMonitor(db, api, () => T0, { pollIntervalMs: 100_000 });
  });

  afterEach(() => {
    monitor.stop();
    db.close();
  });

  function createDispatcher(config?: DispatcherConfig) {
    dispatcher = new TaskDispatcher(db, api, monitor, () => T1, config);
    return dispatcher;
  }

  // --- Basic dispatch ---

  it("dispatches a single runnable task", async () => {
    seedStoryWithTasks(db, [{ task_id: "t1" }]);
    createDispatcher();

    const result = await dispatcher.dispatchAll();

    expect(result.dispatched).toEqual(["t1"]);
    expect(result.errors).toHaveLength(0);

    const task = db.getTask("t1");
    expect(task!.status).toBe("RUNNING");
    expect(task!.session_id).toBe("sessions/1");
  });

  it("starts monitoring the created session", async () => {
    seedStoryWithTasks(db, [{ task_id: "t1" }]);
    createDispatcher();

    await dispatcher.dispatchAll();

    expect(monitor.getTrackedSessionIds()).toEqual(["sessions/1"]);
  });

  it("dispatches multiple independent tasks", async () => {
    seedStoryWithTasks(db, [
      { task_id: "t1" },
      { task_id: "t2" },
    ]);
    createDispatcher();

    const result = await dispatcher.dispatchAll();

    expect(result.dispatched).toEqual(["t1", "t2"]);
    expect(monitor.getTrackedSessionIds()).toHaveLength(2);
  });

  // --- Dependency awareness ---

  it("does not dispatch tasks with unmet dependencies", async () => {
    seedStoryWithTasks(db, [
      { task_id: "t1" },
      { task_id: "t2", deps: ["t1"] },
    ]);
    createDispatcher();

    const result = await dispatcher.dispatchAll();

    expect(result.dispatched).toEqual(["t1"]);
    const t2 = db.getTask("t2");
    expect(t2!.status).toBe("PENDING");
  });

  it("dispatches tasks once dependencies are done", async () => {
    seedStoryWithTasks(db, [
      { task_id: "t1", status: "DONE" },
      { task_id: "t2", deps: ["t1"] },
    ]);
    createDispatcher();

    const result = await dispatcher.dispatchAll();

    expect(result.dispatched).toEqual(["t2"]);
  });

  // --- Parallelism caps ---

  it("respects maxParallelPerStory", async () => {
    seedStoryWithTasks(db, [
      { task_id: "t1" },
      { task_id: "t2" },
      { task_id: "t3" },
    ]);
    createDispatcher({ maxParallelPerStory: 2, maxParallelGlobal: 10 });

    const result = await dispatcher.dispatchAll();

    expect(result.dispatched).toHaveLength(2);
    expect(db.getRunningTaskCount("s1")).toBe(2);
  });

  it("respects maxParallelGlobal across stories", async () => {
    // Story s1
    seedStoryWithTasks(db, [
      { task_id: "t1" },
      { task_id: "t2" },
    ], "s1");
    // Story s2 (reuse agent from s1 setup)
    db.insertStory({ story_id: "s2", project_id: "p1", status: "OPEN", created_at: T0, updated_at: T0 });
    db.insertTask({
      task_id: "t3", story_id: "s2", project_id: "p1", owner_agent_id: "a1",
      title: "Task t3", prompt: "Do t3", status: "PENDING",
      created_at: T0, updated_at: T0,
    });
    db.insertTask({
      task_id: "t4", story_id: "s2", project_id: "p1", owner_agent_id: "a1",
      title: "Task t4", prompt: "Do t4", status: "PENDING",
      created_at: T0, updated_at: T0,
    });

    createDispatcher({ maxParallelPerStory: 10, maxParallelGlobal: 3 });

    const result = await dispatcher.dispatchAll();

    expect(result.dispatched).toHaveLength(3);
    expect(db.getRunningTaskCount()).toBe(3);
  });

  // --- Skips non-PENDING tasks ---

  it("skips already-running tasks", async () => {
    seedStoryWithTasks(db, [
      { task_id: "t1", status: "RUNNING", session_id: "sessions/existing" },
      { task_id: "t2" },
    ]);
    createDispatcher();

    const result = await dispatcher.dispatchAll();

    expect(result.dispatched).toEqual(["t2"]);
  });

  it("skips DONE tasks", async () => {
    seedStoryWithTasks(db, [
      { task_id: "t1", status: "DONE" },
    ]);
    createDispatcher();

    const result = await dispatcher.dispatchAll();
    expect(result.dispatched).toHaveLength(0);
  });

  // --- No active stories ---

  it("returns empty result when no active stories", async () => {
    createDispatcher();
    const result = await dispatcher.dispatchAll();
    expect(result.dispatched).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // --- DONE stories are skipped ---

  it("skips stories with status DONE", async () => {
    seedStoryWithTasks(db, [{ task_id: "t1" }]);
    db.updateStoryStatus("s1", "DONE", T1);
    createDispatcher();

    const result = await dispatcher.dispatchAll();
    expect(result.dispatched).toHaveLength(0);
  });

  // --- API error handling ---

  it("continues dispatching after a per-task API error", async () => {
    seedStoryWithTasks(db, [
      { task_id: "t1", prompt: "FAIL_THIS" },
      { task_id: "t2" },
    ]);
    api = makeApi({ failForTasks: ["FAIL_THIS"] });
    createDispatcher();
    dispatcher = new TaskDispatcher(db, api, monitor, () => T1);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await dispatcher.dispatchAll();
    consoleSpy.mockRestore();

    expect(result.dispatched).toEqual(["t2"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskId).toBe("t1");
    expect(result.errors[0].error).toBe("API error");

    // t1 should still be PENDING
    expect(db.getTask("t1")!.status).toBe("PENDING");
  });

  // --- dispatchForStory ---

  it("dispatches only for the specified story", async () => {
    seedStoryWithTasks(db, [{ task_id: "t1" }], "s1");
    db.insertStory({ story_id: "s2", project_id: "p1", status: "OPEN", created_at: T0, updated_at: T0 });
    db.insertTask({
      task_id: "t2", story_id: "s2", project_id: "p1", owner_agent_id: "a1",
      title: "Task t2", prompt: "Do t2", status: "PENDING",
      created_at: T0, updated_at: T0,
    });
    createDispatcher();

    const result = await dispatcher.dispatchForStory("s1");

    expect(result.dispatched).toEqual(["t1"]);
    expect(db.getTask("t2")!.status).toBe("PENDING");
  });

  // --- Default config ---

  it("uses default config values", async () => {
    seedStoryWithTasks(db, [{ task_id: "t1" }]);
    dispatcher = new TaskDispatcher(db, api, monitor);
    const result = await dispatcher.dispatchAll();
    expect(result.dispatched).toEqual(["t1"]);
  });
});
