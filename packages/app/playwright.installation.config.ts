import { defineConfig, devices } from "@playwright/test";

// Uses the packaged application and real isolated daemons, without starting Metro.
// The daemon helper's temporary CORS origin is replaced before browser navigation.
export default defineConfig({
  // The packaged coordinator is native ESM. Rewriting it as a CommonJS test
  // module breaks its mixed source/build imports before any browser test runs.
  build: { external: ["**/packages/server/dist/**"] },
  testDir: "./e2e/browser",
  testMatch: "**/execution-installation.packaged.spec.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "phone",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
