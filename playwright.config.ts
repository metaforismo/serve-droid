import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "packages/web/e2e",
  testMatch: "**/*.pw.ts",
  timeout: 30_000,
  // Codec and pointer timing tests are sensitive to cross-engine CPU contention
  // on shared CI runners. Keep local runs parallel, but certify browsers serially.
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  webServer: {
    command: "pnpm --filter @serve-droid/web exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    ...(process.env.SERVE_DROID_STABLE_CHROME
      ? [{ name: "stable-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }]
      : []),
  ],
});
