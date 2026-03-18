# What's Missing for Alpha

> Alpha = the daemon can autonomously receive tasks from a local agent, dispatch them to Jules, monitor sessions, handle completions, cascade dependencies, and report status back.

## Current State (Done)

| Component | Location | Status |
|-----------|----------|--------|
| Zod contracts (`EventV1`, `TaskV1`, `StoryV1`, `AgentV1`, `JulesSession`) | `packages/contracts/` | ✅ |
| SQLite DB with all 7 tables, full CRUD, dependency-aware scheduling | `apps/jules-daemon/src/db/` | ✅ |
| `SessionMonitor` — polls Jules API, detects state transitions, emits events, stuck detection | `apps/jules-daemon/src/monitor/session-monitor.ts` | ✅ |
| `EventRouter` — routes events to owner-agent inboxes by `requires` classification | `apps/jules-daemon/src/monitor/event-router.ts` | ✅ |
| `JulesApiClient` — port interface with `createSession`, `getSession`, `approvePlan`, `sendMessage`, `extractPr` | `apps/jules-daemon/src/api/` | ✅ |
| `TaskDispatcher` — picks runnable tasks, creates Jules sessions, binds session IDs, starts monitoring, enforces parallelism caps | `apps/jules-daemon/src/scheduler/` | ✅ |
| MCP server with `jules_get_pending_events` | `apps/mcp-server/` | ✅ |
| 99 tests, build clean | — | ✅ |

---

## Remaining Work

### 1. Happy-Path Completion Handler

**Priority: Critical** · Estimated effort: Medium

When the `SessionMonitor` emits a `completed` event the daemon must:

1. Mark the task as `DONE` in the database.
2. Run dependency resolution — find tasks that are now unblocked.
3. Trigger `TaskDispatcher` to dispatch the newly-runnable tasks.
4. Optionally update the parent story status to `IN_PROGRESS` / `DONE`.

This closes the core automation loop. Without it, completions are recorded but nothing happens next.

**File(s) to create:** `apps/jules-daemon/src/scheduler/completion-handler.ts`

---

### 2. Daemon Main Loop (`DaemonRunner`)

**Priority: Critical** · Estimated effort: Medium

A single orchestrator class that ties everything together in a lifecycle:

1. `start()` — opens DB, creates `SessionMonitor`, `EventRouter`, `TaskDispatcher`, `CompletionHandler`.
2. On each poll cycle: monitor polls → router routes → completion handler processes `auto` completed events → dispatcher dispatches newly-runnable tasks.
3. `stop()` — graceful shutdown, flushes DB to disk.
4. Periodic `db.save()` for crash recovery.

**File(s) to create:** `apps/jules-daemon/src/daemon-runner.ts`

---

### 3. Real `JulesApiClient` Implementation

**Priority: Critical** · Estimated effort: Medium

An HTTP implementation of the `JulesApiClient` interface that calls the Google Jules API:

- `createSession(params)` → `POST` to Jules session creation endpoint.
- `getSession(id)` → `GET` session status.
- `approvePlan(id)` → approve the pending plan.
- `sendMessage(id, msg)` → send feedback to a session.
- `extractPr(id)` → extract PR URL from a completed session.

Must handle auth (API key or OAuth token), retries with exponential backoff, and response validation via `JulesSessionSchema`.

**File(s) to create:** `apps/jules-daemon/src/api/jules-api-http-client.ts`

**Blocker:** Requires Jules API documentation / credentials to implement correctly.

---

### 4. MCP Tools Expansion

**Priority: High** · Estimated effort: Medium

The MCP server currently only exposes `jules_get_pending_events` (JSONL file reader). For alpha, local agents need tools that talk to the daemon's DB:

| Tool | Purpose |
|------|---------|
| `jules_create_story` | Create a new user story with project binding |
| `jules_create_task` | Create a task with prompt, dependencies, and ownership |
| `jules_get_status` | Query task/story/session status |
| `jules_get_inbox` | Read pending inbox messages for the calling agent |
| `jules_ack_inbox` | Acknowledge and dismiss an inbox message |
| `jules_get_summary` | Get a high-level summary (completed, running, blocked, escalated) |

The MCP server needs to import and open the daemon's SQLite database (or communicate with the running daemon via IPC/HTTP).

**File(s) to modify:** `apps/mcp-server/src/index.ts`

---

### 5. CLI Entry Point

**Priority: Medium** · Estimated effort: Small

Commands for human operators:

| Command | Purpose |
|---------|---------|
| `daemon start` | Start the daemon process (foreground or background) |
| `daemon stop` | Graceful shutdown |
| `daemon status` | Show running state, tracked sessions, heartbeat health |
| `daemon summary` | 2-hour check-in view: completed, running, escalations |

**File(s) to create:** `apps/jules-daemon/src/cli.ts`

---

### 6. Configuration & Environment

**Priority: Medium** · Estimated effort: Small

- Config file or env vars for: Jules API credentials, database path, poll interval, parallelism caps, stuck threshold.
- `.env` / `.env.example` with required variables.
- Validation at startup — fail fast if credentials are missing.

**File(s) to create:** `apps/jules-daemon/src/config.ts`

---

## Dependency Order

```
[3] Real API Client ──┐
                      ├──▶ [2] DaemonRunner ──▶ [5] CLI
[1] Completion Handler┘         │
                                ▼
                          [4] MCP Tools
                                │
                          [6] Config
```

Items 1 and 3 can be built in parallel. Item 2 depends on both. Items 4, 5, and 6 can proceed once 2 exists.

---

## Definition of Alpha

The project reaches alpha when:

- [ ] A local agent can create a story and tasks via MCP tools.
- [ ] The daemon auto-dispatches runnable tasks to Jules.
- [ ] The daemon monitors sessions and emits events on state change.
- [ ] Completed sessions automatically mark tasks DONE and unblock dependents.
- [ ] The local agent can read its inbox for questions/failures.
- [ ] A human can run `daemon status` / `daemon summary` to check progress.
- [ ] The system survives a restart (SQLite persistence + migration).
