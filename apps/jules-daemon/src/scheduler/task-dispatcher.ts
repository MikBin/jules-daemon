import type { Database } from "../db/database.js";
import type { JulesApiClient } from "../api/jules-api-client.js";
import type { SessionMonitor } from "../monitor/session-monitor.js";

export interface DispatcherConfig {
  /** Max concurrent RUNNING tasks per story. Default 3. */
  maxParallelPerStory?: number;
  /** Max concurrent RUNNING tasks globally. Default 5. */
  maxParallelGlobal?: number;
}

export interface DispatchResult {
  dispatched: string[];
  errors: Array<{ taskId: string; error: string }>;
}

/**
 * Picks runnable tasks from the database, creates Jules sessions for them,
 * and starts monitoring. Respects per-story and global parallelism caps.
 */
export class TaskDispatcher {
  private readonly maxParallelPerStory: number;
  private readonly maxParallelGlobal: number;

  constructor(
    private readonly db: Database,
    private readonly api: JulesApiClient,
    private readonly monitor: SessionMonitor,
    private readonly clock: () => string = () => new Date().toISOString(),
    config?: DispatcherConfig,
  ) {
    this.maxParallelPerStory = config?.maxParallelPerStory ?? 3;
    this.maxParallelGlobal = config?.maxParallelGlobal ?? 5;
  }

  /**
   * Dispatch runnable tasks across all active stories.
   * Returns the list of dispatched task IDs and any errors encountered.
   */
  async dispatchAll(): Promise<DispatchResult> {
    const result: DispatchResult = { dispatched: [], errors: [] };
    const stories = this.db.getActiveStories();

    for (const story of stories) {
      const storyResult = await this.dispatchForStory(story.story_id as string);
      result.dispatched.push(...storyResult.dispatched);
      result.errors.push(...storyResult.errors);
    }

    return result;
  }

  /**
   * Dispatch runnable tasks for a single story.
   * Respects both per-story and global parallelism caps.
   */
  async dispatchForStory(storyId: string): Promise<DispatchResult> {
    const result: DispatchResult = { dispatched: [], errors: [] };

    const runnable = this.db.getRunnableTasks(storyId);
    if (runnable.length === 0) return result;

    for (const task of runnable) {
      if (!this.canDispatch(storyId)) break;

      const taskId = task.task_id as string;
      try {
        const sessionId = await this.api.createSession({
          repo: task.project_id as string,
          prompt: task.prompt as string,
        });

        const now = this.clock();
        this.db.updateTaskSession(taskId, sessionId, now);
        this.monitor.trackSession(sessionId, "STARTING");
        result.dispatched.push(taskId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ taskId, error: message });
        console.error(`Dispatch failed for task ${taskId}:`, message);
      }
    }

    return result;
  }

  /** Check whether we can dispatch another task given the parallelism caps. */
  private canDispatch(storyId: string): boolean {
    const globalRunning = this.db.getRunningTaskCount();
    if (globalRunning >= this.maxParallelGlobal) return false;

    const storyRunning = this.db.getRunningTaskCount(storyId);
    if (storyRunning >= this.maxParallelPerStory) return false;

    return true;
  }
}
