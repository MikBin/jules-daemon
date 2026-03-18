import { z } from "zod";

/** Jules API session states as observed from the API. */
export const JulesSessionState = z.enum([
  "STARTING",
  "RUNNING",
  "AWAITING_USER_FEEDBACK",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export type JulesSessionState = z.infer<typeof JulesSessionState>;

/** Minimal session shape returned by the Jules API. */
export const JulesSessionSchema = z.object({
  session_id: z.string(),
  state: JulesSessionState,
  owner: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  pr_url: z.string().optional(),
  updated_at: z.string().optional(),
});

export type JulesSession = z.infer<typeof JulesSessionSchema>;
