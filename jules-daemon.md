# Jules Daemon Manager

## Purpose

This document defines a practical design for a `jules-daemon-manager` that maximizes Jules usage, minimizes local-agent token burn, and keeps human intervention close to zero.

The target operating model is:

1. Local agent creates tasks and Jules sessions.
2. Daemon monitors and drives the lifecycle continuously.
3. Local agent wakes up only on actionable exceptions.
4. Human checks every ~2 hours and intervenes only when escalation requires it.

## Why A Separate Daemon

For this use case, a separate daemon process (or separate project) is the right architecture.

1. Local IDE agents are interactive and context-limited, while orchestration must be always-on.
2. Multi-agent and multi-PC coordination requires durable state and ownership routing.
3. Reliability controls (heartbeats, leases, retries, dead-letter handling) belong in a persistent service.
4. Security and policy boundaries are clearer when automation credentials live in one controlled runtime.

## System Goals

1. Near-autonomous task execution with Jules as primary executor.
2. Strict ownership: each agent handles only sessions it started for its current project.
3. Event-driven wake-up for local agents; no active polling loops in local LLM context.
4. Full happy-path automation: approval policy, merge, close session, branch cleanup.
5. Dependency-aware scheduling across user-story tasks.
6. Graceful escalation to agent, then human, when automation cannot proceed safely.

## Non-Goals

1. Replacing local coding agents for ideation or decomposition.
2. Performing arbitrary CI/CD orchestration outside Jules lifecycle.
3. Ignoring repository branch-protection rules to force merges.

## High-Level Architecture

```text
Local Agent A/B/C
  | create task/session + ownership metadata
  v
Jules MCP Server (tool bridge)
  |
  v
Jules Daemon Manager
  |- Session Registry (durable DB)
  |- Event Router (ownership-based dispatch)
  |- Policy Engine (auto-approve/merge gates)
  |- DAG Scheduler (task dependencies)
  |- Retry + Watchdog + Dead Letter
  |- Agent Inboxes (wake-up queues)
  |- Human Notification Channel
  |
  v
Google Jules API + Git hosting API
```

## Core Concepts

### Ownership

Every task/session includes:

1. `agent_id`: logical owner agent identity.
2. `project_id`: stable identifier for the active project/repo context.
3. `story_id`: user-story container for dependent tasks.
4. `task_id`: single unit of work.

Only the owner agent receives wake-up events for those sessions unless failover policy applies.

### Leases

A lease prevents two agents from processing the same task/session concurrently.

1. `lease_owner`
2. `lease_expires_at`
3. heartbeat renewals

On expiration, daemon can reassign or escalate.

### Event Classes

1. `auto`: daemon can resolve deterministically.
2. `agent`: requires local-agent decision (clarification, strategy conflict, non-trivial failure).
3. `human`: policy-risk or repeated failure requiring manual intervention.

## End-To-End Flows

## Flow 1: Task Creation

1. Local agent decomposes story into tasks and dependencies.
2. Agent creates task records with ownership metadata.
3. Daemon starts runnable tasks (deps satisfied) by calling Jules session creation via MCP tools.
4. Session IDs are bound back to task records.

## Flow 2: Monitoring Without Tokens

1. Daemon monitor polls Jules API in background.
2. Status transitions and actionable states produce normalized events.
3. Events are written to durable event log and routed.
4. Local agent remains idle unless it receives an `agent` event.

## Flow 3: Happy Path Automation

1. Session enters `COMPLETED`.
2. Daemon extracts PR details.
3. Daemon validates merge policy and CI status.
4. Daemon merges PR when allowed.
5. Daemon closes session and cleans branch if configured.
6. Daemon marks task done and unlocks dependent tasks.

## Flow 4: Exception Path

1. Question/stuck/failure event arrives.
2. Policy engine attempts deterministic remediation.
3. If unresolved, route to owner-agent inbox with minimal context bundle.
4. If owner agent does not respond in SLA, escalate to human.

## Dependency Scheduling

Use DAG-based scheduling at story level.

1. Tasks with unmet dependencies stay `BLOCKED`.
2. Completed tasks trigger dependency resolution.
3. Newly unblocked tasks are enqueued automatically.
4. Optional `max_parallel_per_story` and `max_parallel_global` caps prevent overload.

## Suggested Data Model

Use SQLite first, migrate to Postgres if multi-host scale requires it.

### `agents`

1. `agent_id` (pk)
2. `host_id`
3. `project_id`
4. `status` (`ONLINE`, `OFFLINE`)
5. `last_heartbeat_at`

### `stories`

1. `story_id` (pk)
2. `project_id`
3. `status`
4. `created_at`
5. `updated_at`

### `tasks`

1. `task_id` (pk)
2. `story_id`
3. `project_id`
4. `owner_agent_id`
5. `title`
6. `prompt`
7. `status` (`PENDING`, `RUNNING`, `BLOCKED`, `DONE`, `FAILED`, `ESCALATED`)
8. `session_id` (nullable)
9. `retry_count`
10. `last_error`
11. `created_at`
12. `updated_at`

### `task_dependencies`

1. `task_id`
2. `depends_on_task_id`

### `events`

1. `event_id` (pk)
2. `event_type`
3. `session_id`
4. `task_id`
5. `owner_agent_id`
6. `payload_json`
7. `observed_at`
8. `routed_to`
9. `processed_at`

### `leases`

1. `resource_type`
2. `resource_id`
3. `lease_owner`
4. `lease_expires_at`

### `inbox_messages`

1. `message_id` (pk)
2. `agent_id`
3. `priority`
4. `state` (`PENDING`, `ACKED`, `EXPIRED`)
5. `payload_json`
6. `created_at`
7. `expires_at`

## Event Contract

Normalized event payload should include:

```json
{
  "event_id": "evt_...",
  "event_type": "question|completed|failed|stuck|dependency_ready",
  "session_id": "sessions/...",
  "task_id": "task_...",
  "story_id": "story_...",
  "project_id": "repo:owner/name",
  "owner_agent_id": "agent_...",
  "severity": "info|warning|critical",
  "requires": "auto|agent|human",
  "summary": "short actionable summary",
  "context_ref": "path or id for full payload",
  "observed_at": "2026-03-17T12:00:00.000Z"
}
```

Keep the payload compact for inbox delivery and store the full raw details separately.

## Policy Engine

Rules should be explicit and versioned.

1. Auto-approve only for low-risk task categories.
2. Auto-merge only when CI is green and branch policy is satisfied.
3. Never auto-merge if protected labels/checks are missing.
4. Limit auto-retries for transient failures.
5. Escalate after `N` retries or repeated stuck intervals.

## Reliability Controls

1. Heartbeat file/record for monitor, watcher, router, scheduler.
2. Exponential backoff on API/network errors.
3. Idempotency keys for side effects (approve, merge, close).
4. Dead-letter queue for repeated processing failures.
5. Startup recovery from persisted offsets and task/session states.

## Security Controls

1. Isolate automation credentials in daemon runtime.
2. Restrict local-agent permissions to task/session submission and inbox ACK/response.
3. Add audit logs for approvals, merges, and escalations.
4. Mask secrets in stored payloads and logs.

## Multi-Agent And Multi-PC Rules

1. Agent identity must be stable across restarts (`agent_id` + host fingerprint).
2. Agents can register multiple projects; each task binds to exactly one project.
3. Ownership routing is strict by `owner_agent_id` and `project_id`.
4. Optional failover transfers ownership only when lease expires and policy allows it.

## 2-Hour Human Check-In Mode

At every check-in, human should only read one summary:

1. Completed tasks and merged PRs.
2. Tasks currently running and ETA confidence.
3. Escalations waiting for agent/human action.
4. Any component heartbeat anomaly.

If summary is clean, no further action is needed.

## Current Repo Gaps To Fix First

Before adding full daemon capabilities, align current scripts and tool contract.

1. Event identity mismatch: monitor emits `session_id` while parts of handler use `job_id`.
2. Missing tool usage in handler: references to `jules_get_artifacts` and `jules_get_job` do not exist in current MCP server.
3. No durable ownership registry yet.
4. No dependency scheduler yet.

## Implementation Roadmap

## Phase 0: Stabilize Existing Stack

1. Normalize event schema around `session_id`.
2. Update handler to use existing tools only (`jules_get_session`, `jules_extract_pr_from_session`, `jules_approve_plan`, `jules_send_message`).
3. Add tests for `question/completed/error/stuck` handling using normalized IDs.
4. Add daemon control scripts (`start`, `stop`, `status`) with heartbeat checks.

## Phase 1: Introduce Ownership

1. Add lightweight registry storage (SQLite).
2. Register agents with `agent_id`, `host_id`, `project_id`.
3. Persist task/session ownership on session creation.
4. Route events to per-agent inbox files.

## Phase 2: Add Scheduler

1. Add story/task/dependency tables.
2. Implement topological runnable-task detection.
3. Auto-dispatch unblocked tasks to Jules.
4. Enforce parallelism caps.

## Phase 3: Automate Happy Path

1. Add policy-driven auto-approve.
2. Add PR extraction and merge automation with CI checks.
3. Add branch/session cleanup.
4. Mark tasks done and unlock downstream dependencies.

## Phase 4: Hardening

1. Add lease system and failover handling.
2. Add dead-letter queue and replay command.
3. Add idempotency keys for all side-effect actions.
4. Add audit trails and structured logs.

## Phase 5: Operator Experience

1. Add `daemon:summary` command for 2-hour check-ins.
2. Add per-project and per-agent dashboards (CLI first).
3. Add notification channels (desktop + optional Slack/email/webhook).
4. Add runbook docs for incident handling.

## Detailed TODO List

## Foundation

- [ ] Create `apps/jules-daemon/` (or separate repo) with standalone `package.json`.
- [ ] Add shared contracts package for event/task schemas.
- [ ] Define canonical `EventV1` and `TaskV1` zod schemas.
- [ ] Add migration scripts for SQLite schema.

## Monitor And Event Pipeline

- [ ] Refactor monitor output to canonical event schema.
- [ ] Ensure each event has unique `event_id` and deterministic dedupe key.
- [ ] Persist monitor offsets/checkpoints for crash recovery.
- [ ] Add integration test: no duplicate processing after restart.

## Ownership And Routing

- [ ] Implement agent registration endpoint/tool.
- [ ] Implement task/session creation endpoint with ownership metadata.
- [ ] Implement per-agent inbox writer and ACK semantics.
- [ ] Add routing tests for multi-agent, multi-project isolation.

## Scheduler

- [ ] Implement task dependency storage and validation (no cycles).
- [ ] Implement runnable queue computation.
- [ ] Trigger dispatch on dependency resolution events.
- [ ] Add tests for partial ordering and blocked tasks.

## Policy Engine

- [ ] Create policy config file (`policies/default.json`).
- [ ] Implement auto-approve rule evaluation.
- [ ] Implement auto-merge rule evaluation with CI checks.
- [ ] Implement escalation rule evaluation and SLA timers.

## Lifecycle Automation

- [ ] On `completed`, call PR extraction and persist PR metadata.
- [ ] If policy passes, merge PR and record result.
- [ ] After merge, close session and cleanup branch.
- [ ] Emit `dependency_ready` events for downstream tasks.

## Exception Handling

- [ ] Implement retry with exponential backoff for transient errors.
- [ ] Track retry budget per task/session.
- [ ] Send unresolved items to dead-letter queue.
- [ ] Implement replay tooling for dead-letter items.

## Ops And Observability

- [ ] Add heartbeat records for all daemon workers.
- [ ] Add `daemon status` command with health summary.
- [ ] Add `daemon summary --since 2h` command.
- [ ] Add structured logging and trace correlation IDs.

## Security

- [ ] Move automation credentials to daemon-only env scope.
- [ ] Add log redaction for secrets/tokens.
- [ ] Add audit log entries for approve/merge/close actions.
- [ ] Add role boundaries for agent vs daemon actions.

## Compatibility With Current Repo

- [ ] Fix event handler to stop using non-existent tools.
- [ ] Align all code to `session_id` naming.
- [ ] Add `jules_get_pending_events` or inbox-based equivalent to reduce local polling tokens.
- [ ] Update README with new architecture and migration path.

## Success Metrics

Track these metrics from day one.

1. Local-agent tokens/hour during long-running orchestration.
2. Percent of tasks completed without human intervention.
3. Mean time from session completion to merged PR.
4. Escalation rate (`auto -> agent -> human`).
5. Stuck-session recovery success rate.

## Recommended Start

Start with a hybrid structure in this repository for speed:

1. Keep existing `mcp-server/` as bridge.
2. Add `apps/jules-daemon/` for orchestration runtime.
3. Add `packages/contracts/` for shared schemas.

Once stable, you can split into separate repos if needed.
