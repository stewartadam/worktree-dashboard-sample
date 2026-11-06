import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dashboardUrl = new URL(
  "../worktree-dashboard/worktree-dashboard.mjs",
  import.meta.url,
).href;

/**
 * Imports the dashboard in a child process (importing starts its HTTP server)
 * and returns its `findListeningPids` result for `port`. The child is a
 * separate process, so listeners held by this test process are not filtered
 * out as the dashboard's own PID.
 */
async function findListeningPidsInDashboard(t, port) {
  const cwd = await mkdtemp(join(tmpdir(), "worktree-dashboard-listeners-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // The dashboard logs its startup line while the lookup is awaited, so the
  // result is written last on its own line.
  const script = `const dashboard = await import(${JSON.stringify(dashboardUrl)}); const result = await dashboard.findListeningPids(${port}); process.stdout.write("\\n" + JSON.stringify(result)); process.exit(0);`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd, env: { ...process.env, WORKTREE_DASHBOARD_PORT: "0" } },
  );
  return JSON.parse(stdout.trimEnd().split("\n").at(-1));
}

/** Starts a TCP listener on an ephemeral port of `host` and closes it when the test ends. */
async function listen(t, host) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0, ipv6Only: host === "::1" }, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

/** Verifies an IPv4 loopback listener resolves to this process's PID. */
test("findListeningPids resolves an IPv4 listener", async (t) => {
  const port = await listen(t, "127.0.0.1");
  const { pids, attempts } = await findListeningPidsInDashboard(t, port);
  assert.deepEqual(pids, [process.pid], attempts.join("; "));
});

/**
 * Probes whether this host can bind the IPv6 loopback, returning a skip reason
 * when the kernel lacks IPv6 (EAFNOSUPPORT) or has no `::1` address
 * (EADDRNOTAVAIL), as in some containers; any other error is rethrown.
 * @returns {Promise<string | false>}
 */
async function ipv6LoopbackSkipReason() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
    });
  } catch (error) {
    if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
      return `IPv6 loopback unavailable on this host (${error.code})`;
    }
    throw error;
  }
  await new Promise((resolve) => server.close(resolve));
  return false;
}

/** Verifies an IPv6-only loopback listener resolves to this process's PID. */
test("findListeningPids resolves an IPv6-only listener", {
  skip: await ipv6LoopbackSkipReason(),
}, async (t) => {
  const port = await listen(t, "::1");
  const { pids, attempts } = await findListeningPidsInDashboard(t, port);
  assert.deepEqual(pids, [process.pid], attempts.join("; "));
});

/** Verifies a free port yields no PIDs and records each lookup method tried. */
test("findListeningPids reports the methods tried for a free port", async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const freePort = server.address().port;
  await new Promise((resolve) => server.close(resolve));

  const { pids, attempts } = await findListeningPidsInDashboard(t, freePort);
  assert.deepEqual(pids, []);
  const expected = {
    darwin: ["lsof", "pid-port"],
    win32: ["pid-port"],
  }[process.platform] ?? ["pid-port", "lsof"];
  assert.deepEqual(
    attempts.map((line) => line.split(":")[0]),
    expected,
  );
});
