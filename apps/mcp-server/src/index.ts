#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";

const server = new McpServer({
  name: "jules-daemon",
  version: "0.1.0",
});

// --- Tool: jules_get_pending_events ---
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
        .describe(
          "Path to events.jsonl (default: events.jsonl in current dir)",
        ),
      since_event_id: z
        .string()
        .optional()
        .describe("Only return events after this ID (for deduplication)"),
    },
  },
  async ({ events_path, since_event_id }) => {
    const path = events_path ?? "events.jsonl";

    try {
      const content = await fs.readFile(path, "utf8");
      const lines = content.trim().split(/\r?\n/).filter(Boolean);
      const events = lines.map((line) => JSON.parse(line));

      const pendingEvents = since_event_id
        ? events.filter(
            (e: { id?: string }) => e.id && e.id > since_event_id,
          )
        : events;

      return {
        content: [
          {
            type: "text" as const,
            text:
              pendingEvents.length === 0
                ? "No pending events"
                : JSON.stringify(pendingEvents, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading events: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Start server (stdio transport) ---
const transport = new StdioServerTransport();
await server.connect(transport);
