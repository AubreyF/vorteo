import path from "node:path";
import { defineConfig } from "vitest/config";
import { WINDOWS_EXCLUDED_SUITES } from "./vitest.windows-exclusions";

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "./src"),
      // Server tests run without building the server, so these self-imports cannot reach dist.
      "@getpaseo/server/factory-contracts": path.resolve(
        __dirname,
        "../../plugins/factory/shared/contracts.ts",
      ),
      "@getpaseo/server/factory-operations": path.resolve(
        __dirname,
        "../../plugins/factory/shared/operations.ts",
      ),
    },
  },
  test: {
    // Fake-timer suites freeze p-throttle's clock, so a real per-second cap deadlocks them.
    env: {
      PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000",
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(__dirname, "./src/test-utils/vitest-setup.ts")],
    pool: "forks",
    fileParallelism: false,
    // Windows runners intermittently starve subprocess-heavy Git tests at the
    // default worker count, leaving child processes alive past their deadlines.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/**",
      "**/.dev/**",
      ...(process.platform === "win32" ? WINDOWS_EXCLUDED_SUITES : []),
    ],
  },
});
