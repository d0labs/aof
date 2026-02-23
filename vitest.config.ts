import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Track boundary coverage, not line coverage
      // These are the public API surfaces we care about
      include: [
        "src/dispatch/scheduler.ts",
        "src/store/task-store.ts",
        "src/service/aof-service.ts",
        "src/gateway/handlers.ts",
        "src/metrics/exporter.ts",
        "src/events/logger.ts",
      ],
      // Explicitly exclude internals — we don't test these directly
      exclude: [
        "src/**/__tests__/**",
        "src/testing/**",
        "src/schemas/**",   // Zod schemas tested via integration
      ],
    },
  },
});
