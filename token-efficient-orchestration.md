# Jules MCP - Token-Efficient Orchestration Guide

**Date:** March 17, 2026  
**Problem:** Local AI agents (like Cline) waste context tokens by actively polling Jules API instead of using efficient background monitoring.

---

## Problem Analysis

### The Core Issue

When orchestrating Jules sessions, AI agents tend to:
1. Call `jules_get_session` repeatedly to check status
2. Call `jules_monitor_session` but then immediately call it again when it returns
3. Consume hundreds/thousands of tokens reading repetitive status information
4. Ask the user "what should I do?" instead of waiting efficiently

**Why this happens:** AI agents are designed for interactive use and don't have a native "sleep for X minutes" capability. They're always in an active "thinking" state.

---

## Current Architecture Review

### Existing Components

| Component | Purpose | Polling Interval |
|-----------|---------|------------------|
| `jules_monitor.js` | Background poller that checks Jules sessions | 45 seconds (configurable) |
| `jules_event_watcher.js` | Watches events file and triggers handlers | 1 second |
| `event_handler.js` | Handles events (questions, completions, errors) | Event-driven |
| `jules_monitor_session` (MCP tool) | Server-side polling with progress notifications | 60 seconds default |

### Why Current Solutions Don't Work Well

1. **`jules_monitor_session` MCP tool:**
   - ✅ Polls server-side (good)
   - ✅ Sends progress notifications (good)
   - ❌ Returns large text responses that consume tokens
   - ❌ Agent calls it repeatedly instead of waiting

2. **Background monitor + event watcher:**
   - ✅ Runs independently (good)
   - ✅ Writes to events file (good)
   - ❌ No mechanism to "wake up" the AI agent
   - ❌ Requires human to notice and prompt agent

---

## Recommended Solutions

### Solution 1: Minimal Polling Pattern (Recommended)

Create a new MCP tool `jules_get_pending_events` that reads from the events file and returns ONLY actionable events with minimal response size.

#### Implementation

Add this tool to `mcp-server/jules_mcp_server.ts`:

```typescript
server.registerTool(
  "jules_get_pending_events",
  {
    title: "Get pending Jules events",
    description:
      "Read pending events from the background monitor's events file. " +
      "Returns only actionable events (questions, completions, errors). " +
      "Use this instead of polling jules_get_session or jules_monitor_session.",
    inputSchema: {
      events_path: z
        .string()
        .optional()
        .describe("Path to events.jsonl (default: events.jsonl in current dir)"),
      since_event_id: z
        .string()
        .optional()
        .describe("Only return events after this ID (for deduplication)"),
    },
  },
  async ({ events_path, since_event_id }, extra) => {
    const fs = await import("fs/promises");
    const path = events_path ?? "events.jsonl";
    
    try {
      const content = await fs.readFile(path, "utf8");
      const lines = content.trim().split(/\r?\n/).filter(Boolean);
      const events = lines.map(line => JSON.parse(line));
      
      // Filter to only new events if since_event_id provided
      const pendingEvents = since_event_id
        ? events.filter(e => e.id && e.id > since_event_id)
        : events;
      
      // Return minimal response
      return {
        content: [{
          type: "text",
          text: pendingEvents.length === 0
            ? "No pending events"
            : JSON.stringify(pendingEvents, null, 2)
        }],
        structuredContent: {
          hasEvents: pendingEvents.length > 0,
          eventCount: pendingEvents.length,
          lastEventId: pendingEvents[pendingEvents.length - 1]?.id,
          events: pendingEvents
        }
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading events: ${(error as Error).message}` }],
        structuredContent: { hasEvents: false, eventCount: 0, error: (error as Error).message }
      };
    }
  }
);
```

#### Agent Instructions (for AGENTS.md)

```markdown
## Jules Session Monitoring - Token-Efficient Pattern

After creating Jules sessions, follow this pattern:

1. **Check for events:**
   ```
   Call: jules_get_pending_events
   ```

2. **If no events (response: "No pending events"):**
   - Report: "All Jules sessions are progressing normally. No action needed."
   - STOP and wait for user to prompt you to check again
   - Do NOT call any other Jules tools

3. **If events exist:**
   - For `question` events: Call `jules_approve_plan` or `jules_send_message`
   - For `completed` events: Call `jules_extract_pr_from_session`
   - For `error` events: Report the error to user

4. **NEVER do this:**
   - ❌ Don't call `jules_get_session` in a loop
   - ❌ Don't call `jules_monitor_session` repeatedly
   - ❌ Don't poll more than once every 5 minutes
```

#### Expected Token Savings

| Pattern | Response Size | Calls per Hour | Tokens/Hour |
|---------|---------------|----------------|-------------|
| `jules_get_session` loop | ~500 tokens | 60 | 30,000 |
| `jules_monitor_session` | ~200 tokens | 12 (5min) | 2,400 |
| `jules_get_pending_events` (empty) | ~10 tokens | 12 (5min) | 120 |
| `jules_get_pending_events` (with events) | ~50 tokens | varies | ~200 |

**Savings: 99%+ reduction in token usage**

---

### Solution 2: Enhanced Desktop Notifications

Modify `event_handler.ts` to send desktop notifications when events occur, so the user knows when to prompt the agent.

#### Implementation

Add to `scripts/event_handler.ts`:

```typescript
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

async function sendDesktopNotification(title: string, message: string): Promise<void> {
  try {
    // Linux (notify-send)
    await execAsync(`notify-send "${title}" "${message}"`);
  } catch {
    try {
      // macOS (osascript)
      await execAsync(`osascript -e 'display notification "${message}" with title "${title}"'`);
    } catch {
      // Windows (not implemented - would use BurntToast or similar)
      console.error(`Notification: ${title} - ${message}`);
    }
  }
}

// In handleQuestion:
await sendDesktopNotification(
  `Jules Session: ${sessionId}`,
  `Session needs your input. State: ${state}`
);

// In handleCompleted:
await sendDesktopNotification(
  `Jules Session Complete`,
  `Session ${sessionId} has finished. State: ${state}`
);

// In handleError:
await sendDesktopNotification(
  `Jules Session Error`,
  `Session ${sessionId} failed. State: ${state}`
);
```

#### Usage

User workflow:
1. Start background monitor: `node build/scripts/jules_monitor.js --config config.json &`
2. Start event watcher: `node build/scripts/jules_event_watcher.js --command "node build/scripts/event_handler.js" &`
3. Get desktop notification when action needed
4. Tell Cline: "Check Jules events - session needs attention"

---

### Solution 3: Startup Daemon Script

Create a script to easily start the background monitoring infrastructure.

#### Implementation

Create `scripts/start-daemon.sh`:

```bash
#!/bin/bash
# start-daemon.sh - Start Jules background monitoring

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"

# Configuration
CONFIG_FILE="${JULES_CONFIG:-$PROJECT_DIR/config.json}"
LOG_DIR="${JULES_LOG_DIR:-$PROJECT_DIR/logs}"
PID_DIR="${JULES_PID_DIR:-$PROJECT_DIR/.pids}"

mkdir -p "$LOG_DIR" "$PID_DIR"

echo "Starting Jules monitoring daemon..."
echo "Config: $CONFIG_FILE"
echo "Logs: $LOG_DIR"

# Start monitor
echo "Starting jules_monitor.js..."
node "$BUILD_DIR/scripts/jules_monitor.js" --config "$CONFIG_FILE" \
  >> "$LOG_DIR/monitor.log" 2>&1 &
MONITOR_PID=$!
echo $MONITOR_PID > "$PID_DIR/monitor.pid"
echo "Monitor PID: $MONITOR_PID"

# Start event watcher
echo "Starting jules_event_watcher.js..."
node "$BUILD_DIR/scripts/jules_event_watcher.js" \
  --config "$CONFIG_FILE" \
  --command "node $BUILD_DIR/scripts/event_handler.js" \
  >> "$LOG_DIR/watcher.log" 2>&1 &
WATCHER_PID=$!
echo $WATCHER_PID > "$PID_DIR/watcher.pid"
echo "Watcher PID: $WATCHER_PID"

echo ""
echo "Jules monitoring daemon started."
echo "  Monitor log: $LOG_DIR/monitor.log"
echo "  Watcher log: $LOG_DIR/watcher.log"
echo ""
echo "To stop: $SCRIPT_DIR/stop-daemon.sh"
```

Create `scripts/stop-daemon.sh`:

```bash
#!/bin/bash
# stop-daemon.sh - Stop Jules background monitoring

PID_DIR="${JULES_PID_DIR:-$(dirname "$0")/../.pids}"

if [ -f "$PID_DIR/monitor.pid" ]; then
  echo "Stopping monitor (PID $(cat $PID_DIR/monitor.pid))..."
  kill "$(cat "$PID_DIR/monitor.pid")" 2>/dev/null || true
  rm "$PID_DIR/monitor.pid"
fi

if [ -f "$PID_DIR/watcher.pid" ]; then
  echo "Stopping watcher (PID $(cat $PID_DIR/watcher.pid))..."
  kill "$(cat "$PID_DIR/watcher.pid")" 2>/dev/null || true
  rm "$PID_DIR/watcher.pid"
fi

echo "Jules monitoring daemon stopped."
```

Create `scripts/check-daemon.sh`:

```bash
#!/bin/bash
# check-daemon.sh - Check Jules daemon status

PID_DIR="${JULES_PID_DIR:-$(dirname "$0")/../.pids}"
LOG_DIR="${JULES_LOG_DIR:-$(dirname "$0")/../logs}"
EVENTS_FILE="${JULES_EVENTS_FILE:-$(dirname "$0")/../events.jsonl}"

echo "Jules Daemon Status"
echo "==================="

if [ -f "$PID_DIR/monitor.pid" ]; then
  PID=$(cat "$PID_DIR/monitor.pid")
  if ps -p "$PID" > /dev/null 2>&1; then
    echo "✓ Monitor running (PID $PID)"
  else
    echo "✗ Monitor not running (stale PID file)"
  fi
else
  echo "✗ Monitor not running (no PID file)"
fi

if [ -f "$PID_DIR/watcher.pid" ]; then
  PID=$(cat "$PID_DIR/watcher.pid")
  if ps -p "$PID" > /dev/null 2>&1; then
    echo "✓ Watcher running (PID $PID)"
  else
    echo "✗ Watcher not running (stale PID file)"
  fi
else
  echo "✗ Watcher not running (no PID file)"
fi

echo ""
echo "Recent Events (last 5):"
if [ -f "$EVENTS_FILE" ]; then
  tail -5 "$EVENTS_FILE" | jq -r '.event + ": " + (.session_id // "unknown")' 2>/dev/null || tail -5 "$EVENTS_FILE"
else
  echo "  No events file found"
fi

echo ""
echo "Recent Log (monitor):"
if [ -f "$LOG_DIR/monitor.log" ]; then
  tail -3 "$LOG_DIR/monitor.log"
else
  echo "  No monitor log found"
fi
```

Update `package.json`:

```json
{
  "scripts": {
    "daemon:start": "bash scripts/start-daemon.sh",
    "daemon:stop": "bash scripts/stop-daemon.sh",
    "daemon:status": "bash scripts/check-daemon.sh",
    "daemon:restart": "npm run daemon:stop && npm run daemon:start"
  }
}
```

---

### Solution 4: Auto-Approve Configuration

For fully autonomous operation, enable auto-approve in `config.json`:

```json
{
  "auto_approve_plans": true,
  "events_path": "events.jsonl",
  "monitor_poll_seconds": 45,
  "watcher_poll_seconds": 1,
  "stuck_minutes": 20
}
```

With this enabled, `event_handler.ts` will automatically call `jules_approve_plan` when a session enters `AWAITING_USER_FEEDBACK` state for plan approval.

**Warning:** This means Jules plans will be approved without human review. Only use this if you trust Jules to make appropriate decisions.

---

## Complete Workflow Example

### Setup (One-Time)

```bash
cd ~/projects/jules-mcp
npm install
npm run build

# Configure
cp config.json config.local.json
# Edit config.local.json:
#   - Set auto_approve_plans: true (optional)
#   - Adjust poll intervals if needed
```

### Start Monitoring

```bash
# Start the background daemons
npm run daemon:start

# Check status
npm run daemon:status
```

### Create Jules Session

Using Cline or MCP client:

```json
{
  "tool": "jules_create_session",
  "arguments": {
    "owner": "MikBin",
    "repo": "algorithmsts",
    "branch": "feat/new-feature",
    "prompt": "Implement feature X following existing patterns",
    "requirePlanApproval": false,
    "automationMode": "AUTO_CREATE_PR"
  }
}
```

### Monitor Efficiently

Using Cline or MCP client (every 5-10 minutes):

```json
{
  "tool": "jules_get_pending_events",
  "arguments": {}
}
```

Expected responses:
- **No events:** `"No pending events"` (~10 tokens)
- **Events pending:** List of actionable events (~50-100 tokens)

### Handle Events

When events are returned:

```json
// For question events:
{
  "tool": "jules_approve_plan",
  "arguments": { "session_id": "sessions/..." }
}

// Or send a message:
{
  "tool": "jules_send_message",
  "arguments": {
    "session_id": "sessions/...",
    "message": "Please proceed with the implementation"
  }
}

// For completed events:
{
  "tool": "jules_extract_pr_from_session",
  "arguments": { "session_id": "sessions/..." }
}
```

### Stop Monitoring

```bash
npm run daemon:stop
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Jules API                                │
│                    (Google Cloud)                               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ polling (45s)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    jules_monitor.js                             │
│              (Background Process - User's Machine)              │
│                                                                 │
│  - Polls Jules API every 45 seconds                             │
│  - Detects state changes                                        │
│  - Writes events to events.jsonl                                │
└───────────────────────────┬─────────────────────────────────────┘
                            │ writes
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      events.jsonl                               │
│                  (Append-only JSONL file)                       │
│                                                                 │
│  {"event":"question","session_id":"...","state":"AWAITING_..."} │
│  {"event":"completed","session_id":"...","state":"COMPLETED"}   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ watches (1s)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  jules_event_watcher.js                         │
│              (Background Process - User's Machine)              │
│                                                                 │
│  - Watches events.jsonl for new events                          │
│  - Triggers event_handler.ts for each event                     │
│  - Sends desktop notifications                                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ executes
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    event_handler.ts                             │
│                  (Event Handler Script)                         │
│                                                                 │
│  - Auto-approves plans (if configured)                          │
│  - Fetches session info / PR details via MCP                    │
│  - Logs to stderr                                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         Cline AI                                │
│                   (MCP Client - Optional)                       │
│                                                                 │
│  1. Creates sessions via jules_create_session                   │
│  2. Periodically calls jules_get_pending_events                 │
│  3. Handles actionable events only                              │
│  4. NEVER polls status directly                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Summary

### Key Takeaways

1. **Don't use `jules_monitor_session`** - It returns too much data and encourages repeated polling

2. **Use background processes** - `jules_monitor.js` + `jules_event_watcher.js` run independently

3. **Add `jules_get_pending_events` tool** - Returns minimal responses (~10 tokens when empty)

4. **Enable desktop notifications** - User gets alerted when action is needed

5. **Consider auto-approve** - For fully autonomous operation (with trust)

### Token Comparison

| Approach | Tokens/Hour | Autonomous | Human Intervention |
|----------|-------------|------------|-------------------|
| Active polling (`jules_get_session`) | 30,000+ | Yes | No |
| `jules_monitor_session` (5min) | 2,400 | Yes | No |
| `jules_get_pending_events` (5min) | 120 | Yes | Only for events |
| Background monitor + notifications | 0 (for AI) | Partial | Yes (to prompt AI) |

### Recommended Setup

For **minimal token usage with human oversight**:
- Run background monitor + watcher
- Enable desktop notifications
- Use `jules_get_pending_events` when prompted
- Review and approve plans manually

For **fully autonomous operation**:
- Run background monitor + watcher
- Set `auto_approve_plans: true`
- Use `jules_get_pending_events` periodically to check completion
- Review PRs when sessions complete

---

## Reliability Fixes (Completed)

The following alignment issues between the monitor and event handler have been resolved:

1. **`session_id` normalization** — `event_handler.ts` previously read `event.job_id` in `handleCompleted`, `handleError`, `handleStuck`, and `main()`, but the monitor always emits `session_id`. All handlers now consistently use `event.session_id`.

2. **Non-existent MCP tool calls removed** — `event_handler.ts` called `jules_get_artifacts` (in `handleCompleted`) and `jules_get_job` (in `handleStuck`), neither of which existed in the MCP server. These have been replaced:
   - `handleCompleted` → calls `jules_extract_pr_from_session` with `session_id`
   - `handleStuck` → calls `jules_get_session` with `session_id`
   - `handleError` → now also calls `jules_get_session` for investigation context

3. **Field naming aligned** — `status` fields in handler log messages replaced with `state` to match the Jules API and monitor event schema.

## Files to Modify

1. **`mcp-server/jules_mcp_server.ts`** - Add `jules_get_pending_events` tool
2. **`scripts/event_handler.ts`** - ~~Add desktop notification support~~ (reliability fixes applied)
3. **`scripts/start-daemon.sh`** - New file for daemon management
4. **`scripts/stop-daemon.sh`** - New file for daemon management
5. **`scripts/check-daemon.sh`** - New file for status checking
6. **`package.json`** - Add daemon scripts
7. **`config.json`** - Update with recommended defaults
8. **`AGENTS.md`** (in algorithmsts repo) - Update with monitoring instructions