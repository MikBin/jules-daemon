/**
 * SQLite schema migration for jules-daemon.
 *
 * Tables mirror the data model in jules-daemon.md:
 *   agents, stories, tasks, task_dependencies,
 *   events, leases, inbox_messages
 */

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: string[] = [
  /* v1 – initial schema */
  `
  CREATE TABLE IF NOT EXISTS agents (
    agent_id       TEXT PRIMARY KEY,
    host_id        TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'ONLINE'
                   CHECK (status IN ('ONLINE', 'OFFLINE')),
    last_heartbeat_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stories (
    story_id   TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    task_id        TEXT PRIMARY KEY,
    story_id       TEXT NOT NULL REFERENCES stories(story_id),
    project_id     TEXT NOT NULL,
    owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    title          TEXT NOT NULL,
    prompt         TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','RUNNING','BLOCKED','DONE','FAILED','ESCALATED')),
    session_id     TEXT,
    retry_count    INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id           TEXT NOT NULL REFERENCES tasks(task_id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
    PRIMARY KEY (task_id, depends_on_task_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id       TEXT PRIMARY KEY,
    event_type     TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    task_id        TEXT NOT NULL,
    story_id       TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    owner_agent_id TEXT NOT NULL,
    severity       TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    requires       TEXT NOT NULL CHECK (requires IN ('auto','agent','human')),
    summary        TEXT NOT NULL,
    context_ref    TEXT,
    observed_at    TEXT NOT NULL,
    routed_to      TEXT,
    processed_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS leases (
    resource_type    TEXT NOT NULL,
    resource_id      TEXT NOT NULL,
    lease_owner      TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    PRIMARY KEY (resource_type, resource_id)
  );

  CREATE TABLE IF NOT EXISTS inbox_messages (
    message_id  TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
    priority    INTEGER NOT NULL DEFAULT 0,
    state       TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (state IN ('PENDING','ACKED','EXPIRED')),
    payload_json TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );
  INSERT INTO schema_version (version) VALUES (1);
  `,
];
