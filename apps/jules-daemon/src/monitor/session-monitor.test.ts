import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionMonitor, type MonitorConfig } from "./session-monitor.js";
import { Database } from "../db/database.js";
import type { JulesApiClient } from "../api/jules-api-client.js";
import type { JulesSession, JulesSessionState } from "@jules-daemon/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi(sessions: Map<string, JulesSession>): JulesApiClient {
  return {
    createSession: async () => "sessions/new",
    getSession: async (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`Session ${id} not found`);
      return s;
    },
    approvePlan: async () => {},
    sendMessage: async () => {},
    extractPr: async () => null,
  };
}

function makeSession(id: string, state: JulesSessionState): JulesSession {
  return { session_id: id, state };
}

const T0 = "2026-03-18T09:00:00.000Z";
const T1 = "2026-03-18T09:01:00.000Z";
const T2 = "2026-03-18T09:30:00.000Z";

function seedTask(db: Database, sessionId: string) {
  db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: T0 });
  db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: T0, updated_at: T0 });
  db.insertTask({
    task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
    title: "Task 1", prompt: "Do stuff", status: "RUNNING",
    session_id: sessionId, created_at: T0, updated_at: T0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionMonitor", () => {
  let db: Database;
  let sessions: Map<string, JulesSession>;
  let api: JulesApiClient;
  let monitor: SessionMonitor;
  let currentTime: string;

  beforeEach(async () => {
    db = await Database.open(":memory:");
    sessions = new Map();
    api = makeApi(sessions);
    currentTime = T0;
    monitor = new SessionMonitor(db, api, () => currentTime, { pollIntervalMs: 100, stuckMinutes: 20 });
  });

  afterEach(() => {
    monitor.stop();
    db.close();
  });

  // --- Tracking ---

  it("tracks and untracks sessions", () => {
    monitor.trackSession("s/1");
    monitor.trackSession("s/2");
    expect(monitor.getTrackedSessionIds()).toEqual(["s/1", "s/2"]);

    monitor.untrackSession("s/1");
    expect(monitor.getTrackedSessionIds()).toEqual(["s/2"]);
  });

  it("getTrackedSessionIds returns empty when nothing tracked", () => {
    expect(monitor.getTrackedSessionIds()).toEqual([]);
  });

  // --- Start / Stop ---

  it("start and stop toggle running flag", () => {
    expect(monitor.running).toBe(false);
    monitor.start();
    expect(monitor.running).toBe(true);
    monitor.stop();
    expect(monitor.running).toBe(false);
  });

  it("start is idempotent", () => {
    monitor.start();
    monitor.start(); // should not throw or double-start
    expect(monitor.running).toBe(true);
  });

  it("stop is idempotent", () => {
    monitor.stop(); // stop before start should not throw
    expect(monitor.running).toBe(false);
  });

  // --- Transition detection ---

  it("emits 'completed' event when session transitions to COMPLETED", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "COMPLETED"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("completed");
    expect(events[0].severity).toBe("info");
    expect(events[0].requires).toBe("auto");
    expect(events[0].task_id).toBe("t1");
    expect(events[0].owner_agent_id).toBe("a1");
  });

  it("emits 'failed' event when session transitions to FAILED", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "FAILED"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("failed");
    expect(events[0].severity).toBe("critical");
    expect(events[0].requires).toBe("agent");
  });

  it("emits 'failed' event when session transitions to CANCELLED", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "CANCELLED"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("failed");
  });

  it("emits 'question' event when session transitions to AWAITING_USER_FEEDBACK", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "AWAITING_USER_FEEDBACK"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("question");
    expect(events[0].severity).toBe("warning");
    expect(events[0].requires).toBe("agent");
  });

  it("does not emit event when state has not changed", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "RUNNING"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(0);
  });

  it("does not emit event for STARTING → RUNNING (no actionable event type)", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "RUNNING"));
    monitor.trackSession("s/1", "STARTING");

    await monitor.pollAll();

    // RUNNING maps to null event type, so no event should be emitted
    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(0);
  });

  // --- Terminal state untracking ---

  it("untracks session after COMPLETED", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "COMPLETED"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();
    expect(monitor.getTrackedSessionIds()).toEqual([]);
  });

  it("untracks session after FAILED", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "FAILED"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();
    expect(monitor.getTrackedSessionIds()).toEqual([]);
  });

  it("untracks session after CANCELLED", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "CANCELLED"));
    monitor.trackSession("s/1", "RUNNING");

    await monitor.pollAll();
    expect(monitor.getTrackedSessionIds()).toEqual([]);
  });

  // --- Stuck detection ---

  it("emits 'stuck' event when RUNNING exceeds stuckMinutes", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "RUNNING"));

    currentTime = T0;
    monitor.trackSession("s/1", "RUNNING");

    // Advance time past stuck threshold (20 min)
    currentTime = "2026-03-18T09:25:00.000Z";
    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("stuck");
    expect(events[0].severity).toBe("warning");
    expect(events[0].requires).toBe("agent");
  });

  it("does not emit stuck if under stuckMinutes", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "RUNNING"));

    currentTime = T0;
    monitor.trackSession("s/1", "RUNNING");

    // Advance time but not past threshold
    currentTime = "2026-03-18T09:15:00.000Z";
    await monitor.pollAll();

    expect(db.getUnprocessedEvents()).toHaveLength(0);
  });

  it("resets stuck timer after emitting stuck event", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "RUNNING"));

    currentTime = T0;
    monitor.trackSession("s/1", "RUNNING");

    // First stuck event
    currentTime = "2026-03-18T09:25:00.000Z";
    await monitor.pollAll();
    expect(db.getUnprocessedEvents()).toHaveLength(1);

    // 5 min later — not enough for another stuck event
    currentTime = "2026-03-18T09:30:00.000Z";
    await monitor.pollAll();
    expect(db.getUnprocessedEvents()).toHaveLength(1); // still just the one

    // 25 min after reset — should get second stuck event
    currentTime = "2026-03-18T09:50:00.000Z";
    await monitor.pollAll();
    expect(db.getUnprocessedEvents()).toHaveLength(2);
  });

  // --- Missing task fallback ---

  it("emits event with empty metadata when no task found for session", async () => {
    // No task seeded for this session
    sessions.set("s/orphan", makeSession("s/orphan", "COMPLETED"));
    monitor.trackSession("s/orphan", "RUNNING");

    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe("");
    expect(events[0].owner_agent_id).toBe("");
  });

  // --- Multiple sessions ---

  it("polls multiple sessions in parallel", async () => {
    seedTask(db, "s/1");
    // Add second task with different session
    db.insertTask({
      task_id: "t2", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
      title: "Task 2", prompt: "More stuff", status: "RUNNING",
      session_id: "s/2", created_at: T0, updated_at: T0,
    });

    sessions.set("s/1", makeSession("s/1", "COMPLETED"));
    sessions.set("s/2", makeSession("s/2", "AWAITING_USER_FEEDBACK"));
    monitor.trackSession("s/1", "RUNNING");
    monitor.trackSession("s/2", "RUNNING");

    await monitor.pollAll();

    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(2);
    const types = events.map(e => e.event_type).sort();
    expect(types).toEqual(["completed", "question"]);
  });

  // --- API error handling ---

  it("continues polling other sessions if one API call fails", async () => {
    seedTask(db, "s/1");
    // s/1 will fail, s/2 will succeed
    sessions.set("s/2", makeSession("s/2", "COMPLETED"));
    // Don't add s/1 to sessions map — getSession will throw
    monitor.trackSession("s/1", "RUNNING");
    monitor.trackSession("s/2", "RUNNING");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await monitor.pollAll();
    consoleSpy.mockRestore();

    // s/2 should still get its event
    const events = db.getUnprocessedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("completed");
  });

  // --- pollSession for untracked session ---

  it("pollSession does nothing for untracked session", async () => {
    await monitor.pollSession("s/unknown");
    expect(db.getUnprocessedEvents()).toHaveLength(0);
  });

  // --- stuck detection only for RUNNING state ---

  it("does not emit stuck for non-RUNNING states", async () => {
    seedTask(db, "s/1");
    sessions.set("s/1", makeSession("s/1", "AWAITING_USER_FEEDBACK"));

    currentTime = T0;
    monitor.trackSession("s/1", "AWAITING_USER_FEEDBACK");

    // Advance way past stuck threshold
    currentTime = "2026-03-18T10:00:00.000Z";
    await monitor.pollAll();

    // Should have 0 events — stuck only fires for RUNNING
    expect(db.getUnprocessedEvents()).toHaveLength(0);
  });

  // --- Default config ---

  it("uses default config values when none provided", async () => {
    const m = new SessionMonitor(db, api);
    // Just verify it constructs without error
    expect(m.running).toBe(false);
  });

  // --- Default clock ---

  it("uses real clock when none provided", async () => {
    const m = new SessionMonitor(db, api);
    m.trackSession("s/1");
    expect(m.getTrackedSessionIds()).toEqual(["s/1"]);
  });
});
