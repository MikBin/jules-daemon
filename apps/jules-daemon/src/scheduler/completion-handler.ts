import type { Database } from "../db/database.js";
import type { TaskDispatcher } from "./task-dispatcher.js";

export class CompletionHandler {
  constructor(
    private readonly db: Database,
    private readonly dispatcher: TaskDispatcher,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Processes a "completed" event from the SessionMonitor.
   * Marks the task as DONE, updates the story status, and triggers dispatch
   * for any newly runnable tasks.
   */
  async handleCompletion(event: Record<string, unknown>): Promise<void> {
    const sessionId = event.session_id as string;
    if (!sessionId) return;

    const task = this.db.getTaskBySession(sessionId);
    if (!task) return;

    const taskId = task.task_id as string;
    const storyId = task.story_id as string;
    const now = this.clock();

    // 1. Mark task as DONE
    this.db.updateTaskStatus(taskId, "DONE", now);

    // 2. Update story status
    const allTasks = this.db.getTasksByStory(storyId);
    if (allTasks.length > 0) {
      const allDone = allTasks.every((t) => t.status === "DONE" || (t.task_id === taskId)); // consider just-updated task
      const newStatus = allDone ? "DONE" : "IN_PROGRESS";

      const story = this.db.getStory(storyId);
      if (story && story.status !== newStatus) {
        this.db.updateStoryStatus(storyId, newStatus, now);
      }
    }

    // 3. Dispatch newly-runnable tasks
    // Database.getRunnableTasks(storyId) internally resolves dependencies
    await this.dispatcher.dispatchForStory(storyId);
  }
}
