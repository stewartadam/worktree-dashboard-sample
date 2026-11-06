import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRequestGuard,
  parseAllowedOrigins,
} from "../worktree-dashboard/request-guard.mjs";

const check = createRequestGuard({
  dashboardHost: "127.0.0.1",
  allowedOrigins: ["https://dash.example.test"],
});

test("non-browser clients on a local address pass", () => {
  assert.deepEqual(check({ host: "127.0.0.1:4781" }), { allowed: true });
  assert.deepEqual(check({ host: "localhost:4781" }), { allowed: true });
  assert.deepEqual(check({ host: "[::1]:4781" }), { allowed: true });
});

test("a rebound or missing Host is refused", () => {
  assert.equal(check({ host: "evil.example.com:4781" }).allowed, false);
  assert.equal(check({}).allowed, false);
});

test("a remote or opaque Origin is refused", () => {
  const host = "127.0.0.1:4781";
  assert.equal(
    check({ host, origin: "https://evil.example.com" }).allowed,
    false,
  );
  assert.equal(check({ host, origin: "null" }).allowed, false);
  assert.equal(
    check({ host, origin: "http://localhost.evil.com" }).allowed,
    false,
  );
});

test("loopback origins pass without CORS, allowed origins with it", () => {
  const host = "127.0.0.1:4781";
  assert.deepEqual(check({ host, origin: "http://localhost:3411" }), {
    allowed: true,
  });
  assert.deepEqual(check({ host, origin: "https://dash.example.test" }), {
    allowed: true,
    corsOrigin: "https://dash.example.test",
  });
  assert.equal(
    check({ host: "dash.example.test", origin: undefined }).allowed,
    true,
  );
});

test("parseAllowedOrigins trims entries", () => {
  assert.deepEqual(parseAllowedOrigins(" http://a.test/, ,http://b.test "), [
    "http://a.test",
    "http://b.test",
  ]);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

/** Starts the real dashboard on an ephemeral port and returns its port. */
async function startDashboard(t) {
  const cwd = await mkdtemp(join(tmpdir(), "worktree-dashboard-guard-"));
  const child = spawn(
    process.execPath,
    [
      new URL("../worktree-dashboard/worktree-dashboard.mjs", import.meta.url)
        .pathname,
    ],
    { cwd, env: { ...process.env, WORKTREE_DASHBOARD_PORT: "0" } },
  );
  t.after(async () => {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/listening on http:\/\/[^:]+:(\d+)/u);
      if (match) resolve(Number(match[1]));
    });
  });
}

/** Sends a POST with exact headers, which fetch would not allow. */
function post(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("the dashboard refuses a cross-origin POST before routing it", async (t) => {
  const port = await startDashboard(t);
  const refused = await post(port, "/api/worktrees/x/stop", {
    Origin: "https://evil.example.com",
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["access-control-allow-origin"], undefined);

  // Without an Origin it is routed: the id is unknown, so not a 403.
  const routed = await post(port, "/not-a-route", {});
  assert.equal(routed.status, 404);
  assert.equal(routed.headers["access-control-allow-origin"], undefined);
});
