import type { JulesSession, JulesSessionState } from "@jules-daemon/contracts";
import type { JulesApiClient } from "../api/jules-api-client.js";
import type { Database } from "../db/database.js";
import crypto from "node:crypto";

export interface MonitorConfig {
  /** Polling interval in milliseconds. Default 45_000. */
  pollIntervalMs?: number;
  /** Minutes before a RUNNING session is considered stuck. Default 20. */
  stuckMinutes?: number;
}

interface TrackedSession {
  sessionId: string;
  lastKnownState: JulesSessionState;
  lastStateChangeAt: string;
}

/**
 * Polls the Jules API for active sessions, detects state transitions,
 * and writes normalized EventV1 records to the database.
 */
export class SessionMonitor {
  private readonly pollIntervalMs: number;
  private readonly stuckMinutes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tracked = new Map<string, TrackedSession>();
  private _running = false;

  constructor(
    private readonly db: Database,
    private readonly api: JulesApiClient,
    private readonly clock: () => string = () => new Date().toISOString(),
    config?: MonitorConfig,
  ) {
    this.pollIntervalMs = config?.pollIntervalMs ?? 45_000;
    this.stuckMinutes = config?.stuckMinutes ?? 20;
  }

  get running(): boolean {
    return this._running;
  }

  /** Begin tracking a session. Called when the daemon dispatches a task. */
  trackSession(sessionId: string, initialState: JulesSessionState = "STARTING"): void {
    this.tracked.set(sessionId, {
      sessionId,
      lastKnownState: initialState,
      lastStateChangeAt: this.clock(),
    });
  }

  /** Stop tracking a session (terminal state reached). */
  untrackSession(sessionId: string): void {
    this.tracked.delete(sessionId);
  }

  /** Return the set of currently tracked session IDs. */
  getTrackedSessionIds(): string[] {
    return [...this.tracked.keys()];
  }

  /** Start the polling loop. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.timer = setInterval(() => void this.pollAll(), this.pollIntervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single poll cycle across all tracked sessions. */
  async pollAll(): Promise<void> {
    const sessionIds = [...this.tracked.keys()];
    const results = await Promise.allSettled(
      sessionIds.map((id) => this.pollSession(id)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        // Log but don't crash the loop
        console.error("Monitor poll error:", result.reason);
      }
    }
  }

  /** Poll a single session and emit events on state change. */
  async pollSession(sessionId: string): Promise<void> {
    const entry = this.tracked.get(sessionId);
    if (!entry) return;

    const session = await this.api.getSession(sessionId);
    const previousState = entry.lastKnownState;
    const currentState = session.state;

    if (currentState !== previousState) {
      entry.lastKnownState = currentState;
      entry.lastStateChangeAt = this.clock();
      this.emitTransitionEvent(session, previousState);
    } else {
      // Check for stuck sessions
      this.checkStuck(entry);
    }

    // Untrack terminal states
    if (currentState === "COMPLETED" || currentState === "FAILED" || currentState === "CANCELLED") {
      this.tracked.delete(sessionId);
    }
  }

  private emitTransitionEvent(session: JulesSession, previousState: JulesSessionState): void {
    const task = this.findTaskForSession(session.session_id);
    const eventType = this.stateToEventType(session.state);
    if (!eventType) return;

    const { severity, requires } = this.classifyEvent(eventType);

    this.db.insertEvent({
      event_id: `evt_${crypto.randomUUID()}`,
      event_type: eventType,
      session_id: session.session_id,
      task_id: task?.task_id as string ?? "",
      story_id: task?.story_id as string ?? "",
      project_id: task?.project_id as string ?? "",
      owner_agent_id: task?.owner_agent_id as string ?? "",
      severity,
      requires,
      summary: `Session ${session.session_id} transitioned to ${session.state}`,
      observed_at: this.clock(),
    });
  }

  private checkStuck(entry: TrackedSession): void {
    if (entry.lastKnownState !== "RUNNING") return;

    const stateChangeTime = new Date(entry.lastStateChangeAt).getTime();
    const now = new Date(this.clock()).getTime();
    const elapsedMinutes = (now - stateChangeTime) / 60_000;

    if (elapsedMinutes >= this.stuckMinutes) {
      const task = this.findTaskForSession(entry.sessionId);

      this.db.insertEvent({
        event_id: `evt_${crypto.randomUUID()}`,
        event_type: "stuck",
        session_id: entry.sessionId,
        task_id: task?.task_id as string ?? "",
        story_id: task?.story_id as string ?? "",
        project_id: task?.project_id as string ?? "",
        owner_agent_id: task?.owner_agent_id as string ?? "",
        severity: "warning",
        requires: "agent",
        summary: `Session ${entry.sessionId} has been RUNNING for ${Math.round(elapsedMinutes)} minutes`,
        observed_at: this.clock(),
      });

      // Reset the timer so we don't emit stuck events every cycle
      entry.lastStateChangeAt = this.clock();
    }
  }

  private stateToEventType(state: JulesSessionState): string | null {
    switch (state) {
      case "COMPLETED":
        return "completed";
      case "FAILED":
        return "failed";
      case "CANCELLED":
        return "failed";
      case "AWAITING_USER_FEEDBACK":
        return "question";
      default:
        return null;
    }
  }

  private classifyEvent(eventType: string): { severity: "info" | "warning" | "critical"; requires: "auto" | "agent" | "human" } {
    switch (eventType) {
      case "completed":
        return { severity: "info", requires: "auto" };
      case "failed":
        return { severity: "critical", requires: "agent" };
      case "question":
      case "stuck":
        return { severity: "warning", requires: "agent" };
      default:
        return { severity: "info", requires: "auto" };
    }
  }

  private findTaskForSession(sessionId: string): Record<string, unknown> | undefined {
    return this.db.getTaskBySession(sessionId);
  }
}
