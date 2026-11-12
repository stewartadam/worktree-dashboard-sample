import { expect, type Page, test } from "@playwright/test";

/** Builds a `/api/system` response, with overrides for the backend details. */
function systemSnapshot({
  pid = 4821,
  loadAverage = [2.1, 1.8, 1.6] as number[] | null,
} = {}) {
  return {
    ok: true,
    backend: {
      pid,
      worktree: "feature-login",
      port: 3040,
      uptimeSeconds: 725,
      requestCount: 1204,
      memoryBytes: 8.2 * 1024 * 1024,
    },
    host: { name: "test-host", os: "macOS 26", arch: "aarch64", coreCount: 4 },
    current: {
      cpuPercent: 23.4,
      coreCpuPercents: [10, 42, 5, 36],
      memoryUsedBytes: 16 * 1024 ** 3,
      memoryTotalBytes: 32 * 1024 ** 3,
      loadAverage,
    },
    history: Array.from({ length: 30 }, (_, index) => ({
      timestampMs: 1_700_000_000_000 + index * 1000,
      cpuPercent: 20 + index,
    })),
  };
}

/** Answers the backend poll, which the page sends across origins. */
async function mockSystem(page: Page, body: unknown) {
  await page.unroute("**/api/system");
  await page.route("**/api/system", (route) =>
    route.fulfill({
      json: body,
      headers: { "access-control-allow-origin": "*" },
    }),
  );
}

test("shows backend details and host stats", async ({ page }) => {
  await mockSystem(page, systemSnapshot());
  await page.goto("/");

  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.getByText("feature-login")).toBeVisible();
  await expect(page.getByText("4821")).toBeVisible();
  await expect(page.getByText("12m 5s")).toBeVisible();
  await expect(page.getByText("1,204")).toBeVisible();
  await expect(page.getByText("Host: test-host")).toBeVisible();
  await expect(page.getByText("23%", { exact: true })).toBeVisible();
  await expect(page.getByText("16.0 GB / 32.0 GB")).toBeVisible();
  await expect(page.getByText("2.10")).toBeVisible();
});

test("reads out a value when hovering the chart and core bars", async ({
  page,
}) => {
  await mockSystem(page, systemSnapshot());
  await page.goto("/");

  const chart = page.getByRole("img", { name: /CPU usage over/ });
  const bounds = await chart.boundingBox();
  if (!bounds) throw new Error("CPU chart is not visible");
  // The last sample sits at the chart's right edge.
  await page.mouse.move(
    bounds.x + bounds.width - 1,
    bounds.y + bounds.height / 2,
  );
  await expect(chart.getByText("49%")).toBeVisible();

  const cores = page.getByRole("img", { name: /Usage per core/ });
  await cores.locator(":scope > div").nth(1).hover();
  await expect(page.getByText("Core 2: 42%")).toBeVisible();
});

test("changes every graph's accent and remembers it after reload", async ({
  page,
}) => {
  await mockSystem(page, systemSnapshot());
  await page.goto("/");

  const picker = page.getByLabel("Graph accent");
  await picker.fill("#e17024");
  await expect(picker).toHaveValue("#e17024");

  const chart = page.getByRole("img", { name: /CPU usage over/ });
  const memory = page.getByRole("img", { name: /of memory in use/ });
  const cores = page.getByRole("img", { name: /Usage per core/ });
  await expect(chart.locator("polyline")).toHaveCSS("stroke", "rgb(225, 112, 36)");
  await expect(memory.locator(":scope > div")).toHaveCSS(
    "background-color",
    "rgb(225, 112, 36)",
  );
  for (const bar of await cores.locator(":scope > div > div").all()) {
    await expect(bar).toHaveCSS("background-color", "rgb(225, 112, 36)");
  }

  await chart.hover();
  await expect(chart.locator(".graph-accent-fill")).toHaveCSS(
    "background-color",
    "rgb(225, 112, 36)",
  );

  await page.reload();
  await expect(picker).toHaveValue("#e17024");
  await expect(chart.locator("polyline")).toHaveCSS("stroke", "rgb(225, 112, 36)");
});

test("ignores an invalid saved accent", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("host-monitor-graph-accent", "not-a-color");
  });
  await mockSystem(page, systemSnapshot());
  await page.goto("/?clawpilotTheme=light");

  await expect(page.getByLabel("Graph accent")).toHaveValue("#b11f4b");
  await expect(
    page.getByRole("img", { name: /CPU usage over/ }).locator("polyline"),
  ).toHaveCSS("stroke", "rgb(177, 31, 75)");
});

test("changes the accent even when storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage is unavailable", "SecurityError");
      },
    });
  });
  await mockSystem(page, systemSnapshot());
  await page.goto("/?clawpilotTheme=dark");

  const picker = page.getByLabel("Graph accent");
  await expect(picker).toHaveValue("#fd8ea1");
  await picker.fill("#e17024");
  await expect(
    page.getByRole("img", { name: /CPU usage over/ }).locator("polyline"),
  ).toHaveCSS("stroke", "rgb(225, 112, 36)");
});

test("hides load average when the host has none", async ({ page }) => {
  await mockSystem(page, systemSnapshot({ loadAverage: null }));
  await page.goto("/");

  await expect(page.getByText("Host: test-host")).toBeVisible();
  await expect(page.getByText("Load average")).toHaveCount(0);
});

test("goes offline and recovers with the restarted backend", async ({
  page,
}) => {
  await mockSystem(page, systemSnapshot());
  await page.goto("/");
  await expect(page.getByText("4821")).toBeVisible();

  await page.unroute("**/api/system");
  await page.route("**/api/system", (route) => route.abort());
  await expect(page.getByText("offline", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Can't reach the backend",
  );
  // The last reading stays up while the backend is away.
  await expect(page.getByText("4821")).toBeVisible();

  await mockSystem(page, systemSnapshot({ pid: 5150 }));
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.getByText("5150")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
