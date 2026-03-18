import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./database.js";

const NOW = "2026-03-18T09:00:00.000Z";
const LATER = "2026-03-18T10:00:00.000Z";

describe("Database", () => {
  let db: Database;

  beforeEach(async () => {
    db = await Database.open(":memory:");
  });

  // ----- Agents -----

  describe("agents", () => {
    it("inserts and retrieves an agent", () => {
      db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
      const agent = db.getAgent("a1");
      expect(agent).toBeDefined();
      expect(agent!.agent_id).toBe("a1");
      expect(agent!.status).toBe("ONLINE");
    });

    it("returns undefined for missing agent", () => {
      expect(db.getAgent("missing")).toBeUndefined();
    });

    it("updates heartbeat", () => {
      db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "OFFLINE", last_heartbeat_at: NOW });
      db.updateAgentHeartbeat("a1", LATER);
      const agent = db.getAgent("a1");
      expect(agent!.last_heartbeat_at).toBe(LATER);
      expect(agent!.status).toBe("ONLINE");
    });
  });

  // ----- Stories -----

  describe("stories", () => {
    it("inserts and retrieves a story", () => {
      db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: NOW, updated_at: NOW });
      const story = db.getStory("s1");
      expect(story).toBeDefined();
      expect(story!.status).toBe("OPEN");
    });

    it("returns undefined for missing story", () => {
      expect(db.getStory("missing")).toBeUndefined();
    });

    it("updates story status", () => {
      db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: NOW, updated_at: NOW });
      db.updateStoryStatus("s1", "IN_PROGRESS", LATER);
      expect(db.getStory("s1")!.status).toBe("IN_PROGRESS");
    });
  });

  // ----- Tasks -----

  describe("tasks", () => {
    beforeEach(() => {
      db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
      db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: NOW, updated_at: NOW });
    });

    it("inserts and retrieves a task", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do stuff", status: "PENDING",
        created_at: NOW, updated_at: NOW,
      });
      const task = db.getTask("t1");
      expect(task).toBeDefined();
      expect(task!.status).toBe("PENDING");
      expect(task!.session_id).toBeNull();
    });

    it("returns undefined for missing task", () => {
      expect(db.getTask("missing")).toBeUndefined();
    });

    it("updates task session and sets status to RUNNING", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do stuff", status: "PENDING",
        created_at: NOW, updated_at: NOW,
      });
      db.updateTaskSession("t1", "sessions/abc", LATER);
      const task = db.getTask("t1");
      expect(task!.session_id).toBe("sessions/abc");
      expect(task!.status).toBe("RUNNING");
    });

    it("lists tasks by story", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do A", status: "PENDING",
        created_at: NOW, updated_at: NOW,
      });
      db.insertTask({
        task_id: "t2", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 2", prompt: "Do B", status: "PENDING",
        created_at: LATER, updated_at: LATER,
      });
      const tasks = db.getTasksByStory("s1");
      expect(tasks).toHaveLength(2);
    });
  });

  // ----- getTaskBySession -----

  describe("getTaskBySession", () => {
    beforeEach(() => {
      db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
      db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: NOW, updated_at: NOW });
    });

    it("finds a task by its session_id", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do A", status: "RUNNING",
        session_id: "sessions/abc", created_at: NOW, updated_at: NOW,
      });
      const task = db.getTaskBySession("sessions/abc");
      expect(task).toBeDefined();
      expect(task!.task_id).toBe("t1");
    });

    it("returns undefined when no task has that session_id", () => {
      expect(db.getTaskBySession("sessions/missing")).toBeUndefined();
    });
  });

  // ----- Dependency scheduling -----

  describe("getRunnableTasks", () => {
    beforeEach(() => {
      db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
      db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: NOW, updated_at: NOW });
    });

    it("returns tasks with no dependencies", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do A", status: "PENDING",
        created_at: NOW, updated_at: NOW,
      });
      const runnable = db.getRunnableTasks("s1");
      expect(runnable).toHaveLength(1);
      expect(runnable[0].task_id).toBe("t1");
    });

    it("blocks tasks with unmet dependencies", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do A", status: "PENDING",
        created_at: NOW, updated_at: NOW,
      });
      db.insertTask({
        task_id: "t2", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 2", prompt: "Do B", status: "PENDING",
        created_at: LATER, updated_at: LATER,
      });
      db.addTaskDependency("t2", "t1");

      const runnable = db.getRunnableTasks("s1");
      expect(runnable).toHaveLength(1);
      expect(runnable[0].task_id).toBe("t1");
    });

    it("unblocks tasks when dependencies complete", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do A", status: "PENDING",
        created_at: NOW, updated_at: NOW,
      });
      db.insertTask({
        task_id: "t2", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 2", prompt: "Do B", status: "PENDING",
        created_at: LATER, updated_at: LATER,
      });
      db.addTaskDependency("t2", "t1");

      // Complete t1
      db.updateTaskStatus("t1", "DONE", LATER);

      const runnable = db.getRunnableTasks("s1");
      expect(runnable).toHaveLength(1);
      expect(runnable[0].task_id).toBe("t2");
    });

    it("does not return non-PENDING tasks", () => {
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "Do A", status: "RUNNING",
        created_at: NOW, updated_at: NOW,
      });
      const runnable = db.getRunnableTasks("s1");
      expect(runnable).toHaveLength(0);
    });
  });

  // ----- Events -----

  describe("events", () => {
    it("inserts and retrieves unprocessed events", () => {
      db.insertEvent({
        event_id: "e1", event_type: "completed", session_id: "sessions/abc",
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        severity: "info", requires: "auto", summary: "Session completed",
        observed_at: NOW,
      });
      const events = db.getUnprocessedEvents();
      expect(events).toHaveLength(1);
      expect(events[0].event_id).toBe("e1");
    });

    it("filters by agent_id", () => {
      db.insertEvent({
        event_id: "e1", event_type: "completed", session_id: "sessions/abc",
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        severity: "info", requires: "auto", summary: "Done",
        observed_at: NOW,
      });
      db.insertEvent({
        event_id: "e2", event_type: "question", session_id: "sessions/def",
        task_id: "t2", story_id: "s1", project_id: "p1", owner_agent_id: "a2",
        severity: "warning", requires: "agent", summary: "Need input",
        observed_at: NOW,
      });
      expect(db.getUnprocessedEvents("a1")).toHaveLength(1);
      expect(db.getUnprocessedEvents("a2")).toHaveLength(1);
    });

    it("marks event as processed", () => {
      db.insertEvent({
        event_id: "e1", event_type: "completed", session_id: "sessions/abc",
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        severity: "info", requires: "auto", summary: "Done",
        observed_at: NOW,
      });
      db.markEventProcessed("e1", LATER);
      expect(db.getUnprocessedEvents()).toHaveLength(0);
    });
  });

  // ----- Leases -----

  describe("leases", () => {
    it("acquires and releases a lease", () => {
      const acquired = db.acquireLease("task", "t1", "agent-a", "2099-01-01T00:00:00Z");
      expect(acquired).toBe(true);

      db.releaseLease("task", "t1", "agent-a");
      const reacquired = db.acquireLease("task", "t1", "agent-b", "2099-01-01T00:00:00Z");
      expect(reacquired).toBe(true);
    });

    it("rejects lease when already held", () => {
      db.acquireLease("task", "t1", "agent-a", "2099-01-01T00:00:00Z");
      const second = db.acquireLease("task", "t1", "agent-b", "2099-01-01T00:00:00Z");
      expect(second).toBe(false);
    });

    it("renews a lease", () => {
      db.acquireLease("task", "t1", "agent-a", "2099-01-01T00:00:00Z");
      const renewed = db.renewLease("task", "t1", "agent-a", "2099-06-01T00:00:00Z");
      expect(renewed).toBe(true);
    });

    it("fails to renew a lease owned by someone else", () => {
      db.acquireLease("task", "t1", "agent-a", "2099-01-01T00:00:00Z");
      const renewed = db.renewLease("task", "t1", "agent-b", "2099-06-01T00:00:00Z");
      expect(renewed).toBe(false);
    });
  });

  // ----- Inbox Messages -----

  describe("inbox messages", () => {
    beforeEach(() => {
      db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
    });

    it("inserts and retrieves pending messages", () => {
      db.insertInboxMessage({
        message_id: "m1", agent_id: "a1", priority: 1,
        payload_json: '{"type":"wake"}', created_at: NOW,
      });
      const msgs = db.getPendingInboxMessages("a1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].state).toBe("PENDING");
    });

    it("acks a message", () => {
      db.insertInboxMessage({
        message_id: "m1", agent_id: "a1", priority: 1,
        payload_json: '{"type":"wake"}', created_at: NOW,
      });
      db.ackInboxMessage("m1");
      expect(db.getPendingInboxMessages("a1")).toHaveLength(0);
    });

    it("orders by priority descending then created_at", () => {
      db.insertInboxMessage({
        message_id: "m1", agent_id: "a1", priority: 0,
        payload_json: '{"type":"low"}', created_at: NOW,
      });
      db.insertInboxMessage({
        message_id: "m2", agent_id: "a1", priority: 10,
        payload_json: '{"type":"high"}', created_at: LATER,
      });
      const msgs = db.getPendingInboxMessages("a1");
      expect(msgs[0].message_id).toBe("m2");
      expect(msgs[1].message_id).toBe("m1");
    });
  });

  // ----- Task Dependencies -----

  describe("task dependencies", () => {
    beforeEach(() => {
      db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
      db.insertStory({ story_id: "s1", project_id: "p1", status: "OPEN", created_at: NOW, updated_at: NOW });
      db.insertTask({
        task_id: "t1", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 1", prompt: "A", status: "PENDING", created_at: NOW, updated_at: NOW,
      });
      db.insertTask({
        task_id: "t2", story_id: "s1", project_id: "p1", owner_agent_id: "a1",
        title: "Task 2", prompt: "B", status: "PENDING", created_at: LATER, updated_at: LATER,
      });
    });

    it("returns dependency IDs for a task", () => {
      db.addTaskDependency("t2", "t1");
      const deps = db.getTaskDependencies("t2");
      expect(deps).toEqual(["t1"]);
    });

    it("returns empty array when no dependencies", () => {
      expect(db.getTaskDependencies("t1")).toEqual([]);
    });
  });

  // ----- File persistence -----

  describe("file persistence", () => {
    const testDbPath = "test-persist.sqlite";

    afterEach(async () => {
      const fs = await import("node:fs");
      try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
    });

    it("saves and reopens a file-backed database", async () => {
      const db1 = await Database.open(testDbPath);
      db1.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
      db1.close(); // triggers save

      // Reopen
      const db2 = await Database.open(testDbPath);
      const agent = db2.getAgent("a1");
      expect(agent).toBeDefined();
      expect(agent!.agent_id).toBe("a1");
      db2.close();
    });

    it("save is a no-op for in-memory databases", () => {
      // db is in-memory (from beforeEach) — save should not throw
      db.save();
    });
  });

  // ----- Schema migration idempotency -----

  describe("migration", () => {
    it("opening the same in-memory DB twice does not fail", async () => {
      const db2 = await Database.open(":memory:");
      db2.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
      expect(db2.getAgent("a1")).toBeDefined();
      db2.close();
    });
  });
});
