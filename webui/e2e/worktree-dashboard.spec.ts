import { expect, test } from "@playwright/test";

const EMPTY_SERVICE_STATE = {
  pid: null,
  running: false,
  startedAt: null,
  lastExitCode: null,
  lastExitSignal: null,
  lastError: null,
  logPath: null,
};

/**
 * Builds the managed-service snapshot expected by the worktree dashboard UI.
 */
function managedServices() {
  return {
    backend: EMPTY_SERVICE_STATE,
    ui: EMPTY_SERVICE_STATE,
  };
}

/**
 * Builds the observed process snapshot expected by the worktree dashboard UI.
 */
function observedProcesses() {
  return {
    backendPortOpen: false,
    webUiPortOpen: false,
    backendPid: null,
    webUiPid: null,
  };
}

/**
 * Creates a minimal dashboard worktree payload for grouping assertions.
 */
function worktree({
  branch,
  envExists,
  port,
}: {
  branch: string;
  envExists: boolean;
  port: number | null;
}) {
  const path = `/tmp/worktree-dashboard/${branch.replaceAll("/", "-")}`;
  return {
    id: btoa(path),
    path,
    name: branch.replaceAll("/", "-"),
    branch,
    head: "0000000000000000000000000000000000000000",
    isMain: branch === "main",
    envPath: `${path}/.env`,
    envExists,
    backendPort: port,
    webUiPort: port === null ? null : port + 1,
    webUiUrl: port === null ? null : `http://localhost:${port + 1}`,
    managed: managedServices(),
    observed: observedProcesses(),
  };
}

test("worktree dashboard groups uninitialized worktrees at the bottom", async ({
  page,
}) => {
  await page.route("**/api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-05-29T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [
          worktree({
            branch: "split/layer-panel-sampling",
            envExists: false,
            port: null,
          }),
          worktree({
            branch: "action-registry",
            envExists: true,
            port: 3080,
          }),
        ],
      }),
    });
  });

  await page.goto("/worktree-dashboard.html");

  await expect(
    page.locator("strong", { hasText: "action-registry" }),
  ).toBeVisible();
  await expect(
    page.locator("strong", { hasText: "split/layer-panel-sampling" }),
  ).toBeVisible();
  await expect(page.getByText("Uninitialized worktrees")).toBeVisible();
  await expect(page.getByText(".env missing")).toBeVisible();
  await expect(page.getByText("Unavailable until .env exists")).toBeVisible();

  const tableText = (await page.locator("tbody").innerText()).toLowerCase();
  expect(tableText.indexOf("action-registry")).toBeLessThan(
    tableText.indexOf("uninitialized worktrees"),
  );
  expect(tableText.indexOf("uninitialized worktrees")).toBeLessThan(
    tableText.indexOf("split/layer-panel-sampling"),
  );
});
