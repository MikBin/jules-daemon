import { z } from "zod";

export const AgentV1Schema = z.object({
  agent_id: z.string(),
  host_id: z.string(),
  project_id: z.string(),
  status: z.enum(["ONLINE", "OFFLINE"]),
  last_heartbeat_at: z.string().datetime(),
});

export type AgentV1 = z.infer<typeof AgentV1Schema>;
