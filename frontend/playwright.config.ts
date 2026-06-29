import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests. They boot the Next.js app and drive it in a real
 * browser. Backend-dependent flows (register → deploy → console) need a running
 * API + Proxmox, so the default suite sticks to UI that renders without them;
 * point `E2E_BASE_URL` at a full deployment to run deeper journeys.
 */
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
    // Allow pointing at a pre-installed Chromium (e.g. a sandbox image) instead of
    // Playwright's managed download. CI installs the matching browser, so it omits this.
    launchOptions: process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {},
  },
  // Only manage a dev server when testing locally (not against E2E_BASE_URL).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { NEXT_PUBLIC_API_URL: "/api" },
      },
});
