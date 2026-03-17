import { z } from "zod";

export const StoryV1Schema = z.object({
  story_id: z.string(),
  project_id: z.string(),
  status: z.enum(["OPEN", "IN_PROGRESS", "DONE"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type StoryV1 = z.infer<typeof StoryV1Schema>;
