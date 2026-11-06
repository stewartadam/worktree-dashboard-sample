import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SERVICES } from "../worktree-dashboard/services.mjs";

const execFileAsync = promisify(execFile);
const mcpPath = fileURLToPath(
  new URL("../worktree-dashboard/worktree-dashboard-mcp.mjs", import.meta.url),
);

/** Serves known worktrees and records lifecycle requests without starting services. */
async function mockDashboard(t) {
  const requests = [];
  const worktrees = ["main", "new-ui"].map((branch) => {
    const path = join(process.cwd(), `mcp-test-${branch}`);
    return {
      id: Buffer.from(path, "utf8").toString("base64url"),
      path,
      name: `mcp-test-${branch}`,
      branch,
      services: Object.fromEntries(
        SERVICES.map((service) => [
          service,
          { running: true, reachable: true, pid: 1234 },
        ]),
      ),
    };
  });
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/api/worktrees") {
      res.end(JSON.stringify({ worktrees }));
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(
      /^\/api\/worktrees\/([^/]+)\/(start|stop|recycle)$/u,
    );
    if (req.method !== "POST" || !worktrees.some((w) => w.id === match?.[1])) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Unknown worktree id" }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    worktrees,
    requests,
  };
}

/** Calls a tool through the MCP server's newline-delimited JSON-RPC transport. */
async function callManage(dashboardUrl, args) {
  const result = execFileAsync(process.execPath, [mcpPath], {
    timeout: 10_000,
    env: { ...process.env, WORKTREE_DASHBOARD_URL: dashboardUrl },
  });
  result.child.stdin.end(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dashboard_worktree_manage", arguments: args },
    })}\n`,
  );
  const { stdout } = await result;
  return JSON.parse(stdout).result;
}

for (const branch of ["main", "new-ui"]) {
  for (const action of ["start", "stop", "recycle"]) {
    test(`MCP ${action} resolves ${branch}'s path to its dashboard id`, async (t) => {
      const dashboard = await mockDashboard(t);
      const worktree = dashboard.worktrees.find((w) => w.branch === branch);
      const result = await callManage(dashboard.url, {
        worktree: worktree.path,
        action,
        services: ["backend"],
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(result.structuredContent.worktree.id, worktree.id);
      assert.deepEqual(
        dashboard.requests.filter((r) => r.method === "POST"),
        [{
          method: "POST",
          url: `/api/worktrees/${worktree.id}/${action}?service=backend`,
        }],
      );
      if (action === "stop") {
        assert.equal(result.structuredContent.startup, null);
      } else {
        assert.equal(result.structuredContent.startup.timedOut, false);
        assert.equal(result.structuredContent.startup.services[0].status, "online");
      }
    });
  }
}

test("MCP manages all services by default", async (t) => {
  const dashboard = await mockDashboard(t);
  const worktree = dashboard.worktrees[0];
  const result = await callManage(dashboard.url, {
    worktree: worktree.path,
    action: "recycle",
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(
    dashboard.requests.filter((r) => r.method === "POST"),
    [{
      method: "POST",
      url: `/api/worktrees/${worktree.id}/recycle?service=all`,
    }],
  );
  assert.deepEqual(
    result.structuredContent.startup.services.map((state) => state.service),
    SERVICES,
  );
});

test("MCP rejects unknown worktree paths before sending a lifecycle request", async (t) => {
  const dashboard = await mockDashboard(t);
  const result = await callManage(dashboard.url, {
    worktree: join(process.cwd(), "mcp-test-unknown"),
    action: "recycle",
    services: ["backend"],
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Worktree path was not found/u);
  assert.deepEqual(dashboard.requests, [{ method: "GET", url: "/api/worktrees" }]);
});
