import type { Database } from "../db/database.js";
import crypto from "node:crypto";

/**
 * Routes unprocessed events to owner-agent inboxes.
 *
 * Events classified as `auto` are marked processed immediately.
 * Events classified as `agent` or `human` produce inbox messages
 * for the owner agent, then are marked processed.
 */
export class EventRouter {
  constructor(
    private readonly db: Database,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Process all unprocessed events, routing each to the appropriate inbox. */
  routeAll(): number {
    const events = this.db.getUnprocessedEvents();
    let routed = 0;
    for (const event of events) {
      this.routeEvent(event);
      routed++;
    }
    return routed;
  }

  /** Route a single event record. */
  routeEvent(event: Record<string, unknown>): void {
    const requires = event.requires as string;
    const eventId = event.event_id as string;
    const now = this.clock();

    if (requires === "auto") {
      // Auto events are just marked processed — no inbox delivery
      this.db.markEventProcessed(eventId, now);
      return;
    }

    // Deliver to owner agent's inbox
    const agentId = event.owner_agent_id as string;
    if (agentId) {
      const priority = requires === "human" ? 10 : 5;
      this.db.insertInboxMessage({
        message_id: `msg_${crypto.randomUUID()}`,
        agent_id: agentId,
        priority,
        payload_json: JSON.stringify({
          event_id: eventId,
          event_type: event.event_type,
          session_id: event.session_id,
          task_id: event.task_id,
          summary: event.summary,
          requires,
        }),
        created_at: now,
      });
    }

    this.db.markEventProcessed(eventId, now);
  }
}
