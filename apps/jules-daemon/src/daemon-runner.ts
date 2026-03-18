import type { Database } from "./db/database.js";
import type { JulesApiClient } from "./api/jules-api-client.js";
import { SessionMonitor } from "./monitor/session-monitor.js";
import { EventRouter } from "./monitor/event-router.js";
import { TaskDispatcher } from "./scheduler/task-dispatcher.js";
import { CompletionHandler } from "./scheduler/completion-handler.js";

export interface DaemonRunnerConfig {
  /** How often the daemon orchestrates a complete lifecycle tick in milliseconds. Default 45_000. */
  pollIntervalMs?: number;
  /** How often the database is saved to disk in milliseconds. Default 30_000. */
  saveIntervalMs?: number;
  /** Clock provider (default is `() => new Date().toISOString()`) */
  clock?: () => string;
}

/**
 * Main orchestrator class for the Jules Daemon.
 * Ties together the DB, API Client, Monitor, Router, Completion Handler, and Dispatcher.
 */
export class DaemonRunner {
  private readonly pollIntervalMs: number;
  private readonly saveIntervalMs: number;
  private readonly clock: () => string;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  private monitor!: SessionMonitor;
  private router!: EventRouter;
  private dispatcher!: TaskDispatcher;
  private completionHandler!: CompletionHandler;

  constructor(
    private readonly db: Database,
    private readonly api: JulesApiClient,
    config?: DaemonRunnerConfig,
  ) {
    this.pollIntervalMs = config?.pollIntervalMs ?? 45_000;
    this.saveIntervalMs = config?.saveIntervalMs ?? 30_000;
    this.clock = config?.clock ?? (() => new Date().toISOString());
  }

  get running(): boolean {
    return this._running;
  }

  /**
   * Initializes internal components and starts the main loop.
   */
  start(): void {
    if (this._running) return;

    // 1. Instantiate internal components
    this.monitor = new SessionMonitor(this.db, this.api, this.clock, {
      // Do not use SessionMonitor's internal polling loop
    });

    // Wire up dispatching components
    this.dispatcher = new TaskDispatcher(this.db, this.api, this.monitor, this.clock);
    this.completionHandler = new CompletionHandler(this.db, this.dispatcher, this.clock);
    this.router = new EventRouter(this.db, this.clock, this.completionHandler);

    this._running = true;

    // 2. Start poll interval
    this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);

    // 3. Start save interval
    this.saveTimer = setInterval(() => this.db.save(), this.saveIntervalMs);
  }

  /**
   * Executes a single poll cycle: monitor -> route -> dispatch.
   * Can be called manually for testing or on each interval tick.
   */
  async tick(): Promise<void> {
    if (!this._running) return;

    try {
      // 1. Monitor polls Jules API, detects state transitions, emits events
      await this.monitor.pollAll();

      // 2. Router processes events.
      // If auto + completed, delegates to CompletionHandler synchronously.
      await this.router.routeAll();

      // 3. Dispatcher dispatches newly-runnable tasks.
      await this.dispatcher.dispatchAll();
    } catch (err) {
      console.error("DaemonRunner tick error:", err);
    }
  }

  /**
   * Gracefully shuts down the daemon by stopping the loop and flushing the DB.
   */
  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }

    // Flush to disk
    this.db.save();
  }
}
