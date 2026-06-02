#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

function readLocalEnv() {
  try {
    return Object.fromEntries(
      readFileSync(path.resolve(process.cwd(), ".env"), "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          return separator === -1
            ? [line, ""]
            : [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } catch {
    return {};
  }
}

const localEnv = readLocalEnv();

const targetPath = path.normalize(
  path.resolve(process.env.WORKTREE_TARGET?.trim() || ""),
);

if (!targetPath) {
  console.error("stop-services: missing target worktree path");
  process.exit(1);
}

const dashboardUrl = (
  process.env.WORKTREE_DASHBOARD_URL ??
  localEnv.WORKTREE_DASHBOARD_URL ??
  `http://${process.env.WORKTREE_DASHBOARD_HOST ?? localEnv.WORKTREE_DASHBOARD_HOST ?? "127.0.0.1"}:${process.env.WORKTREE_DASHBOARD_PORT ?? localEnv.WORKTREE_DASHBOARD_PORT ?? "4781"}`
).replace(/\/+$/u, "");

async function fetchDashboard(route, options) {
  let response;
  try {
    response = await fetch(`${dashboardUrl}${route}`, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error(
      `stop-services: unable to reach worktree dashboard at ${dashboardUrl}. Start it with: npm run worktree:dashboard`,
    );
    if (error instanceof Error && error.message) {
      console.error(error.message);
    }
    process.exit(1);
  }

  const text = await response.text();
  if (!response.ok) {
    console.error(
      `stop-services: dashboard request failed (${response.status}): ${text || response.statusText}`,
    );
    process.exit(1);
  }

  return text;
}

const payload = JSON.parse(await fetchDashboard("/api/worktrees"));
if (!payload || !Array.isArray(payload.worktrees)) {
  console.error("stop-services: dashboard payload is missing worktrees");
  process.exit(1);
}

const match = payload.worktrees.find(
  (entry) =>
    path.normalize(path.resolve(String(entry.path ?? ""))) === targetPath,
);

if (!match) {
  const known = payload.worktrees
    .map((entry) => String(entry.path ?? ""))
    .filter(Boolean)
    .join("\n");
  console.error(
    [
      "stop-services: worktree path was not found in dashboard data.",
      `requested: ${targetPath}`,
      `known:\n${known}`,
    ].join("\n"),
  );
  process.exit(1);
}

const result = JSON.parse(
  await fetchDashboard(
    `/api/worktrees/${encodeURIComponent(String(match.id))}/stop?service=all`,
    { method: "POST" },
  ),
);

console.log(
  JSON.stringify(
    {
      worktree: {
        id: match.id,
        path: match.path,
        branch: match.branch,
        name: match.name,
      },
      action: "stop",
      service: "all",
      result,
    },
    null,
    2,
  ),
);
