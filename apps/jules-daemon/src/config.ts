import { z } from "zod";

const ConfigSchema = z.object({
  JULES_API_TOKEN: z.string().min(1, "JULES_API_TOKEN is required"),
  JULES_DB_PATH: z.string().optional(),
  JULES_POLL_INTERVAL_MS: z.coerce.number().positive().optional(),
  JULES_PARALLELISM_CAP: z.coerce.number().int().positive().optional(),
  JULES_STUCK_THRESHOLD_MS: z.coerce.number().positive().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let config: Config;

try {
  config = ConfigSchema.parse({
    JULES_API_TOKEN: process.env.JULES_API_TOKEN,
    JULES_DB_PATH: process.env.JULES_DB_PATH,
    JULES_POLL_INTERVAL_MS: process.env.JULES_POLL_INTERVAL_MS,
    JULES_PARALLELISM_CAP: process.env.JULES_PARALLELISM_CAP,
    JULES_STUCK_THRESHOLD_MS: process.env.JULES_STUCK_THRESHOLD_MS,
  });
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("Configuration validation failed:");
    for (const issue of error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
  } else {
    console.error("Failed to parse configuration:", error);
  }
  process.exit(1);
}

export { config };
