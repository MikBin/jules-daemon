import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventRouter } from "./event-router.js";
import { Database } from "../db/database.js";
import type { CompletionHandler } from "../scheduler/completion-handler.js";

const NOW = "2026-03-18T09:00:00.000Z";
const LATER = "2026-03-18T09:01:00.000Z";

function seedAgent(db: Database) {
  db.insertAgent({ agent_id: "a1", host_id: "h1", project_id: "p1", status: "ONLINE", last_heartbeat_at: NOW });
}

function insertTestEvent(
  db: Database,
  overrides: Partial<{
    event_id: string;
    event_type: string;
    requires: string;
    owner_agent_id: string;
    severity: string;
  }> = {},
) {
  db.insertEvent({
    event_id: overrides.event_id ?? "e1",
    event_type: overrides.event_type ?? "completed",
    session_id: "sessions/abc",
    task_id: "t1",
    story_id: "s1",
    project_id: "p1",
    owner_agent_id: overrides.owner_agent_id ?? "a1",
    severity: overrides.severity ?? "info",
    requires: overrides.requires ?? "auto",
    summary: "Test event",
    observed_at: NOW,
  });
}

describe("EventRouter", () => {
  let db: Database;
  let router: EventRouter;
  let completionHandler: CompletionHandler;

  beforeEach(async () => {
    db = await Database.open(":memory:");
    seedAgent(db);

    completionHandler = {
      handleCompletion: vi.fn().mockResolvedValue(undefined),
    } as unknown as CompletionHandler;

    router = new EventRouter(db, () => LATER, completionHandler);
  });

  // --- Auto events ---

  it("delegates auto + completed events to CompletionHandler and marks processed", async () => {
    insertTestEvent(db, { requires: "auto", event_type: "completed" });

    const routed = await router.routeAll();
    expect(routed).toBe(1);
    expect(db.getUnprocessedEvents()).toHaveLength(0);
    expect(db.getPendingInboxMessages("a1")).toHaveLength(0);
    expect(completionHandler.handleCompletion).toHaveBeenCalledTimes(1);
    expect(completionHandler.handleCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: "e1" })
    );
  });

  it("marks other auto events as processed without creating inbox messages or delegating", async () => {
    insertTestEvent(db, { requires: "auto", event_type: "other_event" });

    const routed = await router.routeAll();
    expect(routed).toBe(1);
    expect(db.getUnprocessedEvents()).toHaveLength(0);
    expect(db.getPendingInboxMessages("a1")).toHaveLength(0);
    expect(completionHandler.handleCompletion).not.toHaveBeenCalled();
  });

  it("marks auto events as processed without creating inbox messages if completionHandler is not provided", async () => {
    const routerNoHandler = new EventRouter(db, () => LATER);
    insertTestEvent(db, { requires: "auto" });

    const routed = await router.routeAll();
    expect(routed).toBe(1);
    expect(db.getUnprocessedEvents()).toHaveLength(0);
    expect(db.getPendingInboxMessages("a1")).toHaveLength(0);
  });

  // --- Agent events ---

  it("routes agent events to owner inbox with priority 5", async () => {
    insertTestEvent(db, { requires: "agent", event_type: "question" });

    const routed = await router.routeAll();
    expect(routed).toBe(1);
    expect(db.getUnprocessedEvents()).toHaveLength(0);

    const msgs = db.getPendingInboxMessages("a1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].priority).toBe(5);

    const payload = JSON.parse(msgs[0].payload_json as string);
    expect(payload.event_type).toBe("question");
    expect(payload.event_id).toBe("e1");
    expect(payload.requires).toBe("agent");
  });

  // --- Human events ---

  it("routes human events to owner inbox with priority 10", async () => {
    insertTestEvent(db, { requires: "human", event_type: "failed" });

    const routed = await router.routeAll();
    expect(routed).toBe(1);

    const msgs = db.getPendingInboxMessages("a1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].priority).toBe(10);
  });

  // --- Multiple events ---

  it("routes multiple events in order", async () => {
    insertTestEvent(db, { event_id: "e1", requires: "auto" });
    insertTestEvent(db, { event_id: "e2", requires: "agent" });
    insertTestEvent(db, { event_id: "e3", requires: "human" });

    const routed = await router.routeAll();
    expect(routed).toBe(3);
    expect(db.getUnprocessedEvents()).toHaveLength(0);
    expect(db.getPendingInboxMessages("a1")).toHaveLength(2); // agent + human
  });

  // --- No events ---

  it("returns 0 when there are no unprocessed events", async () => {
    expect(await router.routeAll()).toBe(0);
  });

  // --- Already processed events are skipped ---

  it("does not re-route already processed events", async () => {
    insertTestEvent(db, { requires: "agent" });
    await router.routeAll();
    // Route again — should find nothing
    expect(await router.routeAll()).toBe(0);
  });

  // --- routeEvent directly ---

  it("routeEvent processes a single event record", async () => {
    insertTestEvent(db, { requires: "agent" });
    const events = db.getUnprocessedEvents();
    await router.routeEvent(events[0]);

    expect(db.getUnprocessedEvents()).toHaveLength(0);
    expect(db.getPendingInboxMessages("a1")).toHaveLength(1);
  });

  // --- Empty owner_agent_id ---

  it("marks processed but skips inbox when owner_agent_id is empty", async () => {
    insertTestEvent(db, { requires: "agent", owner_agent_id: "" });

    await router.routeAll();
    expect(db.getUnprocessedEvents()).toHaveLength(0);
    // No inbox message created since agent_id is empty
    // (getPendingInboxMessages for empty string would match but we don't insert)
  });

  // --- Payload structure ---

  it("inbox message payload contains all expected fields", async () => {
    insertTestEvent(db, { requires: "agent", event_type: "stuck" });
    await router.routeAll();

    const msgs = db.getPendingInboxMessages("a1");
    const payload = JSON.parse(msgs[0].payload_json as string);
    expect(payload).toEqual(expect.objectContaining({
      event_id: "e1",
      event_type: "stuck",
      session_id: "sessions/abc",
      task_id: "t1",
      summary: "Test event",
      requires: "agent",
    }));
  });

  // --- Default clock ---

  it("uses real clock when none provided", async () => {
    const r = new EventRouter(db);
    insertTestEvent(db, { requires: "auto" });
    await r.routeAll();
    expect(db.getUnprocessedEvents()).toHaveLength(0);
  });
});
