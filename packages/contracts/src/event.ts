import { z } from "zod";

export const EventV1Schema = z.object({
  event_id: z.string(),
  event_type: z.enum([
    "question",
    "completed",
    "failed",
    "stuck",
    "dependency_ready",
  ]),
  session_id: z.string(),
  task_id: z.string(),
  story_id: z.string(),
  project_id: z.string(),
  owner_agent_id: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  requires: z.enum(["auto", "agent", "human"]),
  summary: z.string(),
  context_ref: z.string().optional(),
  observed_at: z.string().datetime(),
});

export type EventV1 = z.infer<typeof EventV1Schema>;
