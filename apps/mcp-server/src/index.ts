#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { Database } from "@jules-daemon/daemon";
import crypto from "node:crypto";

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

// --- Tool: jules_create_story ---
server.registerTool(
  "jules_create_story",
  {
    title: "Create Story",
    description: "Create a new user story with project binding",
    inputSchema: {
      project_id: z.string().describe("The ID of the project"),
    },
  },
  async ({ project_id }) => {
    const story_id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.insertStory({ story_id, project_id, status: "OPEN", created_at: now, updated_at: now });
    return {
      content: [{ type: "text", text: JSON.stringify({ story_id }) }],
    };
  },
);

// --- Tool: jules_create_task ---
server.registerTool(
  "jules_create_task",
  {
    title: "Create Task",
    description: "Create a task with prompt, dependencies, and ownership",
    inputSchema: {
      story_id: z.string().describe("The ID of the story"),
      project_id: z.string().describe("The ID of the project"),
      owner_agent_id: z.string().describe("The ID of the agent owning the task"),
      title: z.string().describe("Title of the task"),
      prompt: z.string().describe("Task prompt / instructions"),
      depends_on: z.array(z.string()).optional().describe("Array of task IDs this task depends on"),
    },
  },
  async ({ story_id, project_id, owner_agent_id, title, prompt, depends_on }) => {
    const task_id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.insertTask({
      task_id,
      story_id,
      project_id,
      owner_agent_id,
      title,
      prompt,
      status: "PENDING",
      created_at: now,
      updated_at: now,
    });

    if (depends_on && depends_on.length > 0) {
      for (const dep of depends_on) {
        db.addTaskDependency(task_id, dep);
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ task_id }) }],
    };
  },
);

// --- Tool: jules_get_status ---
server.registerTool(
  "jules_get_status",
  {
    title: "Get Status",
    description: "Query task, story, or session status. Provide one of the IDs.",
    inputSchema: {
      task_id: z.string().optional().describe("Task ID to query"),
      story_id: z.string().optional().describe("Story ID to query"),
      session_id: z.string().optional().describe("Session ID to query"),
    },
  },
  async ({ task_id, story_id, session_id }) => {
    let result: Record<string, unknown> | undefined;

    if (task_id) {
      result = db.getTask(task_id);
    } else if (story_id) {
      result = db.getStory(story_id);
    } else if (session_id) {
      result = db.getTaskBySession(session_id);
    } else {
      return {
        content: [{ type: "text", text: "Error: You must provide at least one of task_id, story_id, or session_id." }],
        isError: true,
      };
    }

    if (!result) {
      return {
        content: [{ type: "text", text: "Not found." }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- Tool: jules_get_inbox ---
server.registerTool(
  "jules_get_inbox",
  {
    title: "Get Inbox",
    description: "Read pending inbox messages for the calling agent",
    inputSchema: {
      agent_id: z.string().describe("The ID of the calling agent"),
    },
  },
  async ({ agent_id }) => {
    const messages = db.getPendingInboxMessages(agent_id);
    return {
      content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
    };
  },
);

// --- Tool: jules_ack_inbox ---
server.registerTool(
  "jules_ack_inbox",
  {
    title: "Ack Inbox",
    description: "Acknowledge and dismiss an inbox message",
    inputSchema: {
      agent_id: z.string().describe("The ID of the calling agent"),
      message_id: z.string().describe("The ID of the message to acknowledge"),
    },
  },
  async ({ agent_id, message_id }) => {
    db.ackInboxMessage(message_id);
    return {
      content: [{ type: "text", text: `Message ${message_id} acknowledged.` }],
    };
  },
);

// --- Tool: jules_get_summary ---
server.registerTool(
  "jules_get_summary",
  {
    title: "Get Summary",
    description: "Get a high-level summary of tasks and stories (completed, running, blocked, escalated)",
    inputSchema: {},
  },
  async () => {
    const summary = db.getSummary();
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
    }
  }
);

// --- Database connection ---
const dbPath = process.env.JULES_DB_PATH ?? "jules.db";
const db = await Database.open(dbPath);
console.error(`Connected to database at ${dbPath}`);

// --- Start server (stdio transport) ---
const transport = new StdioServerTransport();
await server.connect(transport);
