import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: [
        "apps/jules-daemon/src/**/*.ts",
        "packages/contracts/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/*-client.ts",
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
