import { expect, test } from "@playwright/test";

const SERVICE_CATALOG = [
  {
    name: "backend",
    label: "Backend",
    hasPort: true,
    hasUrl: false,
    oneShot: false,
  },
  { name: "ui", label: "Web UI", hasPort: true, hasUrl: true, oneShot: false },
];

/**
 * Builds a stopped service snapshot expected by the worktree dashboard UI.
 */
function serviceState(port: number | null, url: string | null = null) {
  return {
    pid: null,
    running: false,
    startedAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
    logPath: null,
    port,
    url,
    portOpen: false,
    listenerPid: null,
    reachable: false,
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
    basePort: port,
    services: {
      backend: serviceState(port),
      ui: serviceState(
        port === null ? null : port + 1,
        port === null ? null : `http://localhost:${port + 1}`,
      ),
    },
  };
}

test("worktree dashboard groups uninitialized worktrees at the bottom", async ({
  page,
}) => {
  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-05-29T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        basePortEnv: "WORKTREE_APP_PORT",
        services: SERVICE_CATALOG,
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

test("worktree dashboard builds columns and menus from the service catalog", async ({
  page,
}) => {
  const base = worktree({ branch: "feature", envExists: true, port: 3080 });
  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-05-29T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        basePortEnv: "MY_PORT",
        services: [
          ...SERVICE_CATALOG,
          {
            name: "docs",
            label: "Docs",
            hasPort: true,
            hasUrl: true,
            oneShot: false,
          },
        ],
        worktrees: [
          {
            ...base,
            services: {
              ...base.services,
              docs: serviceState(3082, "http://localhost:3082"),
            },
          },
        ],
      }),
    });
  });

  await page.goto("/worktree-dashboard.html");

  await expect(page.getByRole("columnheader", { name: "Docs" })).toBeVisible();
  await expect(page.getByText("3082")).toBeVisible();
  await expect(page.getByText("MY_PORT=3080")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Docs" })).toHaveAttribute(
    "href",
    "http://localhost:3082",
  );

  await page.getByRole("button", { name: "Stop..." }).click();
  await expect(
    page.getByRole("button", { name: "Docs", exact: true }),
  ).toBeVisible();
});
