import { expect, type Page, test } from "@playwright/test";

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
    canRemove: branch !== "main",
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

// Keep a dashboard API running on this machine from pushing real state over the mocks.
test.beforeEach(async ({ page }) => {
  await page.route("**/worktree-api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "retry: 60000\n\n",
    }),
  );
});

/** Builds a dashboard payload holding the given worktrees. */
function dashboardPayload(
  worktrees: ReturnType<typeof worktree>[],
  generatedAt = "2026-05-29T12:00:00.000Z",
) {
  return {
    generatedAt,
    dashboardPid: 12345,
    basePortEnv: "WORKTREE_APP_PORT",
    services: SERVICE_CATALOG,
    worktrees,
  };
}

/** Serves one state from the worktrees endpoint. */
async function serveWorktrees(
  page: Page,
  worktrees: ReturnType<typeof worktree>[],
) {
  await page.route("**/worktree-api/worktrees", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(dashboardPayload(worktrees)),
    });
  });
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

test("the search box filters worktrees by branch and path", async ({
  page,
}) => {
  await serveWorktrees(page, [
    worktree({ branch: "feature/alpha", envExists: true, port: 3080 }),
    worktree({ branch: "fix/beta", envExists: true, port: 3090 }),
  ]);
  await page.goto("/worktree-dashboard.html");
  await expect(page.locator("strong", { hasText: "fix/beta" })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search worktrees" });
  await search.fill("ALPHA feature");
  await expect(
    page.locator("strong", { hasText: "feature/alpha" }),
  ).toBeVisible();
  await expect(page.locator("strong", { hasText: "fix/beta" })).toHaveCount(0);

  await search.fill("nothing-like-this");
  await expect(
    page.getByText('No worktrees match "nothing-like-this".'),
  ).toBeVisible();
});

test("Shift+Enter creates a worktree for the typed branch", async ({
  page,
}) => {
  await serveWorktrees(page, [
    worktree({ branch: "main", envExists: true, port: 3080 }),
  ]);
  const created: string[] = [];
  await page.route("**/worktree-api/worktrees?branch=*", async (route) => {
    created.push(
      new URL(route.request().url()).searchParams.get("branch") ?? "",
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        action: "created",
        message: "Created feature/new",
        path: "/tmp/new",
      }),
    });
  });
  await page.goto("/worktree-dashboard.html");
  await expect(page.locator("strong", { hasText: "main" })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search worktrees" });
  await search.fill("main");
  await expect(
    page.getByRole("button", { name: "Create worktree" }),
  ).toHaveCount(0);

  await search.fill("feature/new");
  await expect(
    page.getByRole("button", { name: "Create worktree" }),
  ).toBeVisible();
  await search.press("Shift+Enter");
  await expect.poll(() => created).toEqual(["feature/new"]);
});

test("Delete reports a refusal, and Shift forces it", async ({ page }) => {
  const target = worktree({ branch: "feature", envExists: true, port: 3080 });
  await serveWorktrees(page, [target]);
  const removals: string[] = [];
  await page.route("**/worktree-api/worktrees/*/remove*", async (route) => {
    const { search } = new URL(route.request().url());
    removals.push(search);
    if (search.includes("force=1")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: "Removed",
          details: [],
          total: 0,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        reason: "local-changes",
        message: "1 uncommitted change",
        details: ["a.txt"],
        total: 1,
      }),
    });
  });
  await page.goto("/worktree-dashboard.html");

  const dialog = page.getByRole("alertdialog");

  // Cancelling sends nothing.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toContainText("Delete feature?");
  await expect(dialog).toContainText(target.path);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // Escape cancels too.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(removals).toEqual([]);

  // Confirming a plain delete reports the refusal.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    page.getByText(/feature has 1 uncommitted change \(a\.txt\)/u),
  ).toBeVisible();

  // Force stays chosen in the dialog after Shift is released.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.keyboard.down("Shift");
  const force = page.getByRole("button", { name: "Force delete" });
  await expect(force).toBeVisible();
  await force.click({ modifiers: ["Shift"] });
  await page.keyboard.up("Shift");
  await expect(dialog).toContainText("Force delete feature?");
  await expect(dialog).toContainText("permanently discards");
  await dialog.getByRole("button", { name: "Force delete" }).click();

  await expect.poll(() => removals).toEqual(["", "?force=1"]);
});

test("a worktree that can't be removed has Delete disabled", async ({
  page,
}) => {
  await serveWorktrees(page, [
    worktree({ branch: "main", envExists: true, port: 3080 }),
  ]);
  await page.goto("/worktree-dashboard.html");
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
});

test("pushed snapshots update the table, and older ones are ignored", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class FakeEventSource extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() {
        super();
        (window as unknown as { fakeEvents: EventTarget }).fakeEvents = this;
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = FakeEventSource as unknown as typeof EventSource;
  });
  await serveWorktrees(page, [
    worktree({ branch: "first", envExists: true, port: 3080 }),
  ]);
  await page.goto("/worktree-dashboard.html");
  await expect(page.locator("strong", { hasText: "first" })).toBeVisible();

  const push = (branch: string, generatedAt: string) =>
    page.evaluate(
      (data) => {
        (
          window as unknown as { fakeEvents: EventTarget }
        ).fakeEvents.dispatchEvent(new MessageEvent("snapshot", { data }));
      },
      JSON.stringify(
        dashboardPayload(
          [worktree({ branch, envExists: true, port: 3080 })],
          generatedAt,
        ),
      ),
    );

  await push("second", "2026-05-29T12:00:10.000Z");
  await expect(page.locator("strong", { hasText: "second" })).toBeVisible();

  await push("stale", "2026-05-29T12:00:05.000Z");
  await expect(page.locator("strong", { hasText: "second" })).toBeVisible();
  await expect(page.locator("strong", { hasText: "stale" })).toHaveCount(0);
});
