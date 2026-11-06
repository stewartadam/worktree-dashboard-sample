import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  ALL_SELECTOR,
  SERVICE_DEFINITIONS,
  SERVICES,
  servicesForTarget,
} from "./services.mjs";

/** Reads dashboard settings from the `.env` of the directory a client runs in. */
function readLocalEnv() {
  try {
    return parseEnv(readFileSync(resolve(process.cwd(), ".env"), "utf8"));
  } catch {
    return {};
  }
}

const LOCAL_ENV = readLocalEnv();
const DEFAULT_DASHBOARD_HOST =
  process.env.WORKTREE_DASHBOARD_HOST ??
  LOCAL_ENV.WORKTREE_DASHBOARD_HOST ??
  "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = Number.parseInt(
  process.env.WORKTREE_DASHBOARD_PORT ??
    LOCAL_ENV.WORKTREE_DASHBOARD_PORT ??
    "4781",
  10,
);
export const DASHBOARD_BASE_URL = (
  process.env.WORKTREE_DASHBOARD_URL ??
  LOCAL_ENV.WORKTREE_DASHBOARD_URL ??
  `http://${DEFAULT_DASHBOARD_HOST}:${DEFAULT_DASHBOARD_PORT}`
).replace(/\/+$/u, "");
const STARTUP_WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.WORKTREE_DASHBOARD_STARTUP_WAIT_MS ?? "90000",
  10,
);
const STARTUP_POLL_INTERVAL_MS = Number.parseInt(
  process.env.WORKTREE_DASHBOARD_STARTUP_POLL_MS ?? "500",
  10,
);
const DASHBOARD_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.WORKTREE_DASHBOARD_REQUEST_TIMEOUT_MS ?? "30000",
  10,
);
const LOG_TAIL_MAX_LINES = 80;
const LOG_TAIL_MAX_CHARS = 8000;
export const MANAGE_ACTIONS = ["start", "stop", "recycle"];

/**
 * Resolves a path to its canonical real path so worktree paths compare equal
 * regardless of symlinks, falling back to the plain resolved path when it does
 * not exist. Windows paths are lowercased because its filesystem is
 * case-insensitive.
 */
export function normalizePath(pathValue) {
  const resolved = resolve(pathValue);
  try {
    const real = realpathSync.native(resolved);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

/**
 * Describes a service's lifecycle in one phrase by combining whether the
 * dashboard manages a running process with whether the service is reachable, so
 * externally started services are reported too. One-shot jobs report
 * completed/failed instead of reachability.
 */
export function statusSummary(worktree, service) {
  const state = worktree.services?.[service];

  if (SERVICE_DEFINITIONS[service]?.oneShot) {
    if (state?.running) return "managed running";
    if (state?.reachable) return "completed";
    if ((state?.lastExitCode ?? null) !== null || state?.lastError) {
      return "failed";
    }
    return "stopped";
  }

  if (state?.running && state.reachable) return "managed + reachable";
  if (state?.running) return "managed starting/unreachable";
  if (state?.reachable) return "external process detected";
  return "stopped";
}

/**
 * Reduces a full dashboard worktree payload to its identity, base port, and each
 * service's status phrase, port, URL and managed process.
 */
export function summarizeWorktree(worktree) {
  return {
    id: worktree.id,
    path: worktree.path,
    name: worktree.name,
    branch: worktree.branch,
    basePort: worktree.basePort,
    services: Object.fromEntries(
      SERVICES.map((service) => {
        const state = worktree.services?.[service];
        return [
          service,
          {
            status: statusSummary(worktree, service),
            port: state?.port ?? null,
            url: state?.url ?? null,
            running: Boolean(state?.running),
            pid: state?.pid ?? null,
          },
        ];
      }),
    ),
  };
}

/** Resolves after `ms` milliseconds; used to pace startup polling. */
function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/**
 * Trims each string in `values` and returns the non-empty ones in first-seen
 * order without duplicates, ignoring non-string entries and non-array input.
 */
export function uniqueNonEmptyStrings(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const ordered = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

/**
 * Expands group selectors such as `all` to their member services and deduplicates the result, keeping the order in which services were first
 * named.
 */
export function resolveWorktreeServiceTargets(values) {
  return uniqueNonEmptyStrings(
    uniqueNonEmptyStrings(values).flatMap(
      (target) => servicesForTarget(target) ?? [target],
    ),
  );
}

/**
 * Classifies a service after a start or recycle as `online` (reachable, or a
 * one-shot job that exited cleanly), `failed` (exited or errored), or `pending`
 * (still starting), alongside its process details.
 */
function classifyStartup(worktree, service) {
  const state = worktree.services?.[service] ?? null;
  const details = {
    service,
    pid: state?.pid ?? null,
    logPath: state?.logPath ?? null,
    lastExitCode: state?.lastExitCode ?? null,
    lastExitSignal: state?.lastExitSignal ?? null,
    lastError: state?.lastError ?? null,
  };

  if (state?.reachable) {
    return { ...details, status: "online" };
  }
  if (state?.running) {
    return { ...details, status: "pending" };
  }
  if ((state?.lastExitCode ?? null) !== null || state?.lastError) {
    return { ...details, status: "failed" };
  }
  return { ...details, status: "pending" };
}

/**
 * Keeps the last non-blank lines of a log, capped by line count and then by
 * character count, so failure details stay readable.
 */
function trimLogTail(rawText) {
  const lines = rawText
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .slice(-LOG_TAIL_MAX_LINES);
  const tail = lines.join("\n");
  if (tail.length <= LOG_TAIL_MAX_CHARS) {
    return tail;
  }
  return tail.slice(-LOG_TAIL_MAX_CHARS);
}

/**
 * Reads the trimmed tail of a service log, returning null for a missing path
 * or empty log and the read error's message when the file cannot be read.
 */
async function readLogTail(logPath) {
  if (!logPath) return null;
  try {
    const raw = await readFile(logPath, "utf8");
    if (!raw.trim()) return null;
    return trimLogTail(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to read log tail: ${message}`;
  }
}

/**
 * Attaches the log tail to each failed service state so callers can show why
 * startup failed.
 */
function withFailureLogTails(states) {
  return Promise.all(
    states.map(async (state) => ({
      ...state,
      logTail:
        state.status === "failed" ? await readLogTail(state.logPath) : null,
    })),
  );
}

/**
 * Polls the dashboard until every service in `services` is online or failed,
 * or until `waitTimeoutMs` elapses, and returns each service's final state
 * with log tails for failures.
 */
async function waitForStartupOutcome(
  worktreePath,
  services,
  { waitTimeoutMs, requestTimeoutMs },
) {
  const startedAt = Date.now();
  let latest = findWorktree(
    await fetchWorktrees({ requestTimeoutMs }),
    worktreePath,
  );

  while (Date.now() - startedAt < waitTimeoutMs) {
    const states = services.map((target) => classifyStartup(latest, target));
    const complete = states.every(
      (state) => state.status === "online" || state.status === "failed",
    );
    if (complete) {
      return {
        timedOut: false,
        waitMs: Date.now() - startedAt,
        services: await withFailureLogTails(states),
        worktree: latest,
      };
    }

    await delay(STARTUP_POLL_INTERVAL_MS);
    latest = findWorktree(
      await fetchWorktrees({ requestTimeoutMs }),
      worktreePath,
    );
  }

  return {
    timedOut: true,
    waitMs: Date.now() - startedAt,
    services: await withFailureLogTails(
      services.map((target) => classifyStartup(latest, target)),
    ),
    worktree: latest,
  };
}

/**
 * Raised when the connection to the dashboard address is refused, meaning no
 * dashboard is running, as opposed to a misconfigured address or a dashboard
 * that answers with an error. Callers can treat it as "no managed services".
 */
export class DashboardUnreachableError extends Error {}

/**
 * Sends a request to the dashboard API and returns the response body,
 * throwing an actionable error when the dashboard is unreachable, times out
 * after `requestTimeoutMs`, or answers with a non-2xx status.
 */
async function fetchDashboard(
  path,
  options,
  requestTimeoutMs = DASHBOARD_REQUEST_TIMEOUT_MS,
) {
  const url = `${DASHBOARD_BASE_URL}${path}`;
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      throw new Error(
        `Worktree dashboard request timed out after ${requestTimeoutMs}ms: ${url}`,
        { cause: error },
      );
    }
    if (error?.cause?.code === "ECONNREFUSED") {
      throw new DashboardUnreachableError(
        `No worktree dashboard is running at ${DASHBOARD_BASE_URL}. Start it with: npm run worktree:dashboard`,
        { cause: error },
      );
    }
    const reason = error?.cause?.message ?? error?.message ?? String(error);
    throw new Error(
      `Unable to reach worktree dashboard at ${DASHBOARD_BASE_URL}: ${reason}`,
      { cause: error },
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Dashboard request failed (${response.status}): ${text || response.statusText}`,
    );
  }
  return text;
}

/** Fetches the full state of every worktree the dashboard discovered. */
export async function fetchWorktrees({ requestTimeoutMs } = {}) {
  const raw = await fetchDashboard(
    "/api/worktrees",
    undefined,
    requestTimeoutMs,
  );
  const payload = JSON.parse(raw);
  if (!payload || !Array.isArray(payload.worktrees)) {
    throw new Error("Dashboard payload is missing worktrees");
  }
  return payload.worktrees;
}

/**
 * Finds the worktree whose path matches `worktreePath` after normalization,
 * throwing with the list of known paths when none does.
 */
export function findWorktree(worktrees, worktreePath) {
  const target = normalizePath(worktreePath);
  const match = worktrees.find(
    (entry) => normalizePath(String(entry.path)) === target,
  );
  if (match) {
    return match;
  }

  const known = worktrees.map((entry) => String(entry.path)).join("\n");
  throw new Error(
    `Worktree path was not found in dashboard data.\nrequested: ${worktreePath}\nknown:\n${known}`,
  );
}

/**
 * Runs a lifecycle action against services of one worktree (a dashboard
 * worktree entry) through the dashboard API. Targeting every managed service
 * sends one `service=all` request. With `wait`, start and recycle then poll
 * until each service comes online or fails, up to `waitTimeoutMs`, so the
 * result reports the real outcome rather than just that the dashboard
 * accepted the request.
 */
export async function manageWorktree(
  worktree,
  action,
  services,
  {
    wait = true,
    waitTimeoutMs = STARTUP_WAIT_TIMEOUT_MS,
    requestTimeoutMs = DASHBOARD_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const targets = uniqueNonEmptyStrings(services);
  const targetsAll = SERVICES.every((service) => targets.includes(service));
  const actionResults = await Promise.all(
    (targetsAll ? [ALL_SELECTOR] : targets).map(async (targetService) => {
      const raw = await fetchDashboard(
        `/api/worktrees/${encodeURIComponent(worktree.id)}/${encodeURIComponent(action)}?service=${encodeURIComponent(targetService)}`,
        { method: "POST" },
        requestTimeoutMs,
      );
      return {
        service: targetService,
        result: JSON.parse(raw),
      };
    }),
  );

  if (wait && (action === "start" || action === "recycle")) {
    const startupOutcome = await waitForStartupOutcome(worktree.path, targets, {
      waitTimeoutMs,
      requestTimeoutMs,
    });
    return {
      worktree: summarizeWorktree(startupOutcome.worktree),
      action: actionResults,
      startup: {
        timedOut: startupOutcome.timedOut,
        waitMs: startupOutcome.waitMs,
        services: startupOutcome.services,
      },
    };
  }

  const refreshed = findWorktree(
    await fetchWorktrees({ requestTimeoutMs }),
    worktree.path,
  );
  return {
    worktree: summarizeWorktree(refreshed),
    action: actionResults,
    startup: null,
  };
}
