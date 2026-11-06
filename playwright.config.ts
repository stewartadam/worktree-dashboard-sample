import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

function readDashboardUiPort(): number {
  const envPort = process.env.WORKTREE_DASHBOARD_UI_PORT?.trim();
  if (envPort && Number.isFinite(Number(envPort))) {
    return Number.parseInt(envPort, 10);
  }

  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return 3031;

  const envFile = readFileSync(envPath, "utf8");
  const match = envFile.match(/^WORKTREE_DASHBOARD_UI_PORT=(\d+)$/m);
  return match ? Number.parseInt(match[1], 10) : 3031;
}

const webPort = readDashboardUiPort();
const baseURL = `http://127.0.0.1:${webPort}`;
const dashboardURL = `${baseURL}/worktree-dashboard.html`;

export default defineConfig({
  testDir: "./webui/e2e",
  timeout: 30_000,
  // E2E specs share one local dashboard API process.
  workers: 1,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/playwright",
  use: {
    browserName: "chromium",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1366, height: 900 },
    baseURL,
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: dashboardURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
