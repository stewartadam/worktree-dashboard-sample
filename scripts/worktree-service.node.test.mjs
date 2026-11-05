import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SERVICES } from "../worktree-dashboard/services.mjs";
import { parseCliArgs } from "../worktree-dashboard/worktree-service.mjs";

const execFileAsync = promisify(execFile);
const servicePath = fileURLToPath(
  new URL("../worktree-dashboard/worktree-service.mjs", import.meta.url),
);
const WT = `--worktree=${process.cwd()}`;
const CLOSED_DASHBOARD_URL = `http://127.0.0.1:${await closedPort()}`;

/**
 * Returns a local port that nothing listens on, by binding an ephemeral port
 * and releasing it, so connections to it are refused.
 */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Runs the service CLI at `scriptPath` against `dashboardUrl` (by default an
 * address nothing listens on) and returns its exit code and output.
 */
async function runService(
  args,
  { dashboardUrl = CLOSED_DASHBOARD_URL, scriptPath = servicePath } = {},
) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [scriptPath, ...args],
      {
        env: {
          ...process.env,
          WORKTREE_DASHBOARD_URL: dashboardUrl,
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** Verifies restart defaults to waiting on every service of the given worktree. */
test("restart targets every service and waits by default", () => {
  assert.deepEqual(parseCliArgs(["--worktree=/w/a", "restart"]), {
    command: "restart",
    worktree: "/w/a",
    services: SERVICES,
    wait: true,
    waitTimeoutMs: 600_000,
    bestEffort: false,
    json: false,
  });
});

/** Verifies --no-wait, --timeout, and --best-effort are parsed. */
test("wait and best-effort options parse", () => {
  const parsed = parseCliArgs([
    "--worktree=/w/a",
    "start",
    "--no-wait",
    "--timeout",
    "45",
    "--best-effort",
  ]);
  assert.equal(parsed.wait, false);
  assert.equal(parsed.waitTimeoutMs, 45_000);
  assert.equal(parsed.bestEffort, true);
});

/** Verifies repeated and comma-separated services merge, and groups expand to their members. */
test("services accept repeats, commas, and groups", () => {
  assert.deepEqual(
    parseCliArgs([
      "--worktree=/w/a",
      "start",
      "-s",
      "backend, ui",
      "--service",
      "ui",
    ]).services,
    ["backend", "ui"],
  );
  assert.deepEqual(
    parseCliArgs(["--worktree=/w/a", "stop", "-s", "all"]).services,
    SERVICES,
  );
  assert.deepEqual(
    parseCliArgs(["--worktree=/w/a", "start", "-s", "ui,both"]).services,
    ["ui", "backend"],
  );
});

/** Verifies bad commands, services, stray arguments, misplaced options, and a missing worktree are rejected. */
test("invalid arguments are rejected", () => {
  const wt = "--worktree=/w/a";
  assert.throws(() => parseCliArgs([wt, "reboot"]), /Unknown command/);
  assert.throws(() => parseCliArgs([wt, "toString"]), /Unknown command/);
  assert.throws(
    () => parseCliArgs([wt, "start", "-s", "backend, db"]),
    /Unknown service "db"/,
  );
  assert.throws(() => parseCliArgs([wt, "start", "-s", ","]), /at least one/);
  assert.throws(
    () => parseCliArgs([wt, "list", "extra"]),
    /Unexpected argument/,
  );
  assert.throws(
    () => parseCliArgs([wt, "status", "-s", "ui"]),
    /--service does not apply to status/,
  );
  assert.throws(
    () => parseCliArgs([wt, "stop", "--no-wait"]),
    /do not apply to stop/,
  );
  assert.throws(
    () => parseCliArgs([wt, "start", "--timeout", "0"]),
    /positive number/,
  );
  assert.throws(() => parseCliArgs(["restart"]), /--worktree/);
  assert.equal(parseCliArgs(["list"]).command, "list");
  assert.equal(parseCliArgs([wt]).command, "help");
});

/** Verifies stop succeeds when no dashboard is running. */
test("stop succeeds when the dashboard is not running", async () => {
  const result = await runService([WT, "stop", "-s", "all"]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /no managed services to stop/u);
});

/** Verifies a malformed dashboard address is an error, not "no services". */
test("stop fails on a malformed dashboard address", async () => {
  const result = await runService([WT, "stop"], {
    dashboardUrl: "http://[::1",
  });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /no managed services/u);
});

/** Verifies --best-effort turns any failure into a warning with exit 0. */
test("best-effort never fails", async () => {
  const result = await runService([WT, "restart", "--best-effort"], {
    dashboardUrl: "http://[::1",
  });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /^warning: /mu);
});

/** Verifies commands other than stop fail when no dashboard is running. */
test("restart fails when the dashboard is not running", async () => {
  const result = await runService([WT, "restart"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No worktree dashboard is running/u);
});

/** Verifies the CLI still runs when invoked through a symlinked path. */
test("runs when invoked through a symlink", async (t) => {
  const linkRoot = await mkdtemp(join(tmpdir(), "worktree-service-link-"));
  t.after(() => rm(linkRoot, { recursive: true, force: true }));
  const linkedDir = join(linkRoot, "worktree-dashboard");
  await symlink(dirname(servicePath), linkedDir);
  const result = await runService([WT, "restart"], {
    scriptPath: join(linkedDir, "worktree-service.mjs"),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No worktree dashboard is running/u);
});
