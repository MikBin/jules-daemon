import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import fs from "node:fs";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export class Database {
  private constructor(private db: SqlJsDatabase, private filePath: string | null) {}

  /**
   * Open (or create) a database.
   * Pass `":memory:"` or omit `filePath` for an in-memory database.
   */
  static async open(filePath?: string): Promise<Database> {
    const SQL = await initSqlJs();
    const isMemory = !filePath || filePath === ":memory:";

    let db: SqlJsDatabase;
    if (!isMemory && fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA foreign_keys = ON;");

    const instance = new Database(db, isMemory ? null : filePath);
    instance.migrate();
    return instance;
  }

  /** Run pending migrations. */
  private migrate(): void {
    const current = this.getSchemaVersion();
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]);
    }
  }

  private getSchemaVersion(): number {
    try {
      const result = this.db.exec("SELECT version FROM schema_version LIMIT 1");
      if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0] as number;
      }
    } catch {
      // table doesn't exist yet
    }
    return 0;
  }

  // -------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------

  insertAgent(agent: { agent_id: string; host_id: string; project_id: string; status: string; last_heartbeat_at: string }): void {
    this.db.run(
      `INSERT INTO agents (agent_id, host_id, project_id, status, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?)`,
      [agent.agent_id, agent.host_id, agent.project_id, agent.status, agent.last_heartbeat_at],
    );
  }

  getAgent(agentId: string): Record<string, unknown> | undefined {
    const stmt = this.db.prepare("SELECT * FROM agents WHERE agent_id = ?");
    stmt.bind([agentId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row as Record<string, unknown>;
    }
    stmt.free();
    return undefined;
  }

  updateAgentHeartbeat(agentId: string, heartbeatAt: string): void {
    this.db.run(
      "UPDATE agents SET last_heartbeat_at = ?, status = 'ONLINE' WHERE agent_id = ?",
      [heartbeatAt, agentId],
    );
  }

  // -------------------------------------------------------------------
  // Stories
  // -------------------------------------------------------------------

  insertStory(story: { story_id: string; project_id: string; status: string; created_at: string; updated_at: string }): void {
    this.db.run(
      `INSERT INTO stories (story_id, project_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [story.story_id, story.project_id, story.status, story.created_at, story.updated_at],
    );
  }

  getStory(storyId: string): Record<string, unknown> | undefined {
    const stmt = this.db.prepare("SELECT * FROM stories WHERE story_id = ?");
    stmt.bind([storyId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row as Record<string, unknown>;
    }
    stmt.free();
    return undefined;
  }

  updateStoryStatus(storyId: string, status: string, updatedAt: string): void {
    this.db.run(
      "UPDATE stories SET status = ?, updated_at = ? WHERE story_id = ?",
      [status, updatedAt, storyId],
    );
  }

  /** Return all stories that are not DONE. */
  getActiveStories(): Record<string, unknown>[] {
    const results = this.db.exec(
      "SELECT * FROM stories WHERE status != 'DONE' ORDER BY created_at",
    );
    if (results.length === 0) return [];
    return this.rowsToObjects(results[0]);
  }

  // -------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------

  insertTask(task: {
    task_id: string;
    story_id: string;
    project_id: string;
    owner_agent_id: string;
    title: string;
    prompt: string;
    status: string;
    session_id?: string | null;
    created_at: string;
    updated_at: string;
  }): void {
    this.db.run(
      `INSERT INTO tasks (task_id, story_id, project_id, owner_agent_id, title, prompt, status, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.task_id, task.story_id, task.project_id, task.owner_agent_id, task.title, task.prompt, task.status, task.session_id ?? null, task.created_at, task.updated_at],
    );
  }

  getTask(taskId: string): Record<string, unknown> | undefined {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?");
    stmt.bind([taskId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row as Record<string, unknown>;
    }
    stmt.free();
    return undefined;
  }

  updateTaskStatus(taskId: string, status: string, updatedAt: string): void {
    this.db.run(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?",
      [status, updatedAt, taskId],
    );
  }

  updateTaskSession(taskId: string, sessionId: string, updatedAt: string): void {
    this.db.run(
      "UPDATE tasks SET session_id = ?, status = 'RUNNING', updated_at = ? WHERE task_id = ?",
      [sessionId, updatedAt, taskId],
    );
  }

  getTasksByStory(storyId: string): Record<string, unknown>[] {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY created_at");
    stmt.bind([storyId]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return rows;
  }

  getTaskBySession(sessionId: string): Record<string, unknown> | undefined {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE session_id = ? LIMIT 1");
    stmt.bind([sessionId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row as Record<string, unknown>;
    }
    stmt.free();
    return undefined;
  }

  /** Count tasks with status RUNNING across all stories (or a single story). */
  getRunningTaskCount(storyId?: string): number {
    const sql = storyId
      ? "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'RUNNING' AND story_id = ?"
      : "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'RUNNING'";
    const results = this.db.exec(sql, storyId ? [storyId] : []);
    if (results.length === 0) return 0;
    return results[0].values[0][0] as number;
  }

  /** Return tasks whose dependencies are all DONE and that are still PENDING. */
  getRunnableTasks(storyId: string): Record<string, unknown>[] {
    const results = this.db.exec(`
      SELECT t.* FROM tasks t
      WHERE t.story_id = ?
        AND t.status = 'PENDING'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON dep.task_id = td.depends_on_task_id
          WHERE td.task_id = t.task_id
            AND dep.status != 'DONE'
        )
      ORDER BY t.created_at
    `, [storyId]);
    if (results.length === 0) return [];
    return this.rowsToObjects(results[0]);
  }

  // -------------------------------------------------------------------
  // Task Dependencies
  // -------------------------------------------------------------------

  addTaskDependency(taskId: string, dependsOnTaskId: string): void {
    this.db.run(
      "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
      [taskId, dependsOnTaskId],
    );
  }

  getTaskDependencies(taskId: string): string[] {
    const stmt = this.db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?");
    stmt.bind([taskId]);
    const ids: string[] = [];
    while (stmt.step()) {
      ids.push(stmt.getAsObject().depends_on_task_id as string);
    }
    stmt.free();
    return ids;
  }

  // -------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------

  insertEvent(event: {
    event_id: string;
    event_type: string;
    session_id: string;
    task_id: string;
    story_id: string;
    project_id: string;
    owner_agent_id: string;
    severity: string;
    requires: string;
    summary: string;
    context_ref?: string | null;
    observed_at: string;
  }): void {
    this.db.run(
      `INSERT INTO events (event_id, event_type, session_id, task_id, story_id, project_id, owner_agent_id, severity, requires, summary, context_ref, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.event_id, event.event_type, event.session_id, event.task_id, event.story_id, event.project_id, event.owner_agent_id, event.severity, event.requires, event.summary, event.context_ref ?? null, event.observed_at],
    );
  }

  getUnprocessedEvents(agentId?: string): Record<string, unknown>[] {
    const sql = agentId
      ? "SELECT * FROM events WHERE processed_at IS NULL AND owner_agent_id = ? ORDER BY observed_at"
      : "SELECT * FROM events WHERE processed_at IS NULL ORDER BY observed_at";
    const results = this.db.exec(sql, agentId ? [agentId] : []);
    if (results.length === 0) return [];
    return this.rowsToObjects(results[0]);
  }

  markEventProcessed(eventId: string, processedAt: string): void {
    this.db.run(
      "UPDATE events SET processed_at = ? WHERE event_id = ?",
      [processedAt, eventId],
    );
  }

  // -------------------------------------------------------------------
  // Leases
  // -------------------------------------------------------------------

  acquireLease(resourceType: string, resourceId: string, owner: string, expiresAt: string): boolean {
    // Delete expired leases first
    this.db.run(
      "DELETE FROM leases WHERE resource_type = ? AND resource_id = ? AND lease_expires_at < datetime('now')",
      [resourceType, resourceId],
    );
    try {
      this.db.run(
        "INSERT INTO leases (resource_type, resource_id, lease_owner, lease_expires_at) VALUES (?, ?, ?, ?)",
        [resourceType, resourceId, owner, expiresAt],
      );
      return true;
    } catch {
      // already held by someone else
      return false;
    }
  }

  renewLease(resourceType: string, resourceId: string, owner: string, expiresAt: string): boolean {
    this.db.run(
      "UPDATE leases SET lease_expires_at = ? WHERE resource_type = ? AND resource_id = ? AND lease_owner = ?",
      [expiresAt, resourceType, resourceId, owner],
    );
    return this.db.getRowsModified() > 0;
  }

  releaseLease(resourceType: string, resourceId: string, owner: string): void {
    this.db.run(
      "DELETE FROM leases WHERE resource_type = ? AND resource_id = ? AND lease_owner = ?",
      [resourceType, resourceId, owner],
    );
  }

  // -------------------------------------------------------------------
  // Inbox Messages
  // -------------------------------------------------------------------

  insertInboxMessage(msg: {
    message_id: string;
    agent_id: string;
    priority: number;
    payload_json: string;
    created_at: string;
    expires_at?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO inbox_messages (message_id, agent_id, priority, state, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
      [msg.message_id, msg.agent_id, msg.priority, msg.payload_json, msg.created_at, msg.expires_at ?? null],
    );
  }

  getPendingInboxMessages(agentId: string): Record<string, unknown>[] {
    const results = this.db.exec(
      "SELECT * FROM inbox_messages WHERE agent_id = ? AND state = 'PENDING' ORDER BY priority DESC, created_at",
      [agentId],
    );
    if (results.length === 0) return [];
    return this.rowsToObjects(results[0]);
  }

  ackInboxMessage(messageId: string): void {
    this.db.run("UPDATE inbox_messages SET state = 'ACKED' WHERE message_id = ?", [messageId]);
  }

  // -------------------------------------------------------------------
  // Summaries
  // -------------------------------------------------------------------

  getSummary(): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      stories: { OPEN: 0, IN_PROGRESS: 0, DONE: 0 },
      PENDING: 0,
      RUNNING: 0,
      DONE: 0,
      FAILED: 0,
      BLOCKED: 0,
      ESCALATED: 0,
    };

    const storyResults = this.db.exec("SELECT status, COUNT(*) as cnt FROM stories GROUP BY status");
    if (storyResults.length > 0) {
      for (const row of storyResults[0].values) {
        const status = row[0] as string;
        const count = row[1] as number;
        (summary.stories as Record<string, number>)[status] = count;
      }
    }

    const taskResults = this.db.exec(`
      SELECT t.status, COUNT(*) as cnt
      FROM tasks t
      JOIN stories s ON t.story_id = s.story_id
      WHERE s.status != 'DONE'
      GROUP BY t.status
    `);
    if (taskResults.length > 0) {
      for (const row of taskResults[0].values) {
        const status = row[0] as string;
        const count = row[1] as number;
        summary[status] = count;
      }
    }

    return summary;
  }

  // -------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------

  /** Flush WAL to disk (call periodically or on shutdown). */
  save(): void {
    if (this.filePath) {
      const data = this.db.export();
      fs.writeFileSync(this.filePath, Buffer.from(data));
    }
  }

  close(): void {
    this.save();
    this.db.close();
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private rowsToObjects(result: { columns: string[]; values: unknown[][] }): Record<string, unknown>[] {
    return result.values.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });
  }
}
