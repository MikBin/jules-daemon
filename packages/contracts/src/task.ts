import { z } from "zod";

export const TaskStatus = z.enum([
  "PENDING",
  "RUNNING",
  "BLOCKED",
  "DONE",
  "FAILED",
  "ESCALATED",
]);

export const TaskV1Schema = z.object({
  task_id: z.string(),
  story_id: z.string(),
  project_id: z.string(),
  owner_agent_id: z.string(),
  title: z.string(),
  prompt: z.string(),
  status: TaskStatus,
  session_id: z.string().nullable().optional(),
  retry_count: z.number().int().default(0),
  last_error: z.string().nullable().optional(),
  depends_on: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type TaskV1 = z.infer<typeof TaskV1Schema>;
