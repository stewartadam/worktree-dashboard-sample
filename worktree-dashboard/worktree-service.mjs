#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DASHBOARD_BASE_URL,
  DashboardUnreachableError,
  fetchWorktrees,
  findWorktree,
  manageWorktree,
  resolveWorktreeServiceTargets,
  summarizeWorktree,
} from "./dashboard-client.mjs";
import { ALL_SELECTOR, SERVICE_TARGET_NAMES, SERVICES } from "./services.mjs";

const COMMAND_ACTIONS = { start: "start", stop: "stop", restart: "recycle" };
const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const BEST_EFFORT_REQUEST_TIMEOUT_MS = 5000;

const USAGE = `Usage: wt [-C <worktree>] service <command> [options]

Manages this worktree's services through the worktree dashboard API
(npm run worktree:dashboard). Use wt -C <path> to target another worktree.

Commands:
  list                   List worktrees with their ports and service status
  status                 Show service status for this worktree
  start                  Start services and wait until they are reachable
  stop                   Stop services
  restart                Restart services and wait until they are reachable

Options:
  -s, --service <name>   Service to target, repeatable or comma separated:
                         ${SERVICE_TARGET_NAMES.join(", ")}
                         (default: ${ALL_SELECTOR})
      --no-wait          Return once the dashboard accepts start/restart
      --timeout <secs>   How long start/restart wait for services
                         (default: ${DEFAULT_WAIT_TIMEOUT_SECONDS})
      --best-effort      Give up after ${BEST_EFFORT_REQUEST_TIMEOUT_MS / 1000}s per request and always exit 0,
                         reporting failures as warnings (used by hooks)
      --json             Print the raw result as JSON
  -h, --help             Show this help`;

/**
 * Parses CLI arguments into a command, the target worktree path, the services
 * to target, wait behavior, and output flags. Throws on unknown commands or
 * services, extra positional arguments, options that do not apply to the
 * command, or a missing worktree for commands that need one.
 */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      worktree: { type: "string" },
      service: { type: "string", short: "s", multiple: true },
      wait: { type: "boolean", default: true },
      timeout: { type: "string" },
      "best-effort": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...extra] = positionals;
  if (values.help || !command) {
    return { command: "help" };
  }
  if (
    command !== "list" &&
    command !== "status" &&
    !Object.hasOwn(COMMAND_ACTIONS, command)
  ) {
    throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
  if (extra.length > 0) {
    throw new Error(`Unexpected argument "${extra[0]}"`);
  }
  if (command !== "list" && !values.worktree) {
    throw new Error("--worktree <path> is required");
  }

  const manages = Object.hasOwn(COMMAND_ACTIONS, command);
  const waits = command === "start" || command === "restart";
  if (!manages && values.service) {
    throw new Error(`--service does not apply to ${command}`);
  }
  if (!waits && (!values.wait || values.timeout !== undefined)) {
    throw new Error(`--no-wait and --timeout do not apply to ${command}`);
  }

  let waitTimeoutSeconds = DEFAULT_WAIT_TIMEOUT_SECONDS;
  if (values.timeout !== undefined) {
    waitTimeoutSeconds = Number(values.timeout);
    if (!Number.isFinite(waitTimeoutSeconds) || waitTimeoutSeconds <= 0) {
      throw new Error("--timeout must be a positive number of seconds");
    }
  }

  const requested = (values.service ?? [ALL_SELECTOR])
    .flatMap((value) => value.split(","))
    .map((service) => service.trim());
  const unknown = requested.filter(
    (service) => service && !SERVICE_TARGET_NAMES.includes(service),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown service "${unknown[0]}"; expected one of: ${SERVICE_TARGET_NAMES.join(", ")}`,
    );
  }

  const services = resolveWorktreeServiceTargets(requested);
  if (services.length === 0) {
    throw new Error("--service needs at least one service name");
  }

  return {
    command,
    worktree: values.worktree ?? null,
    services,
    wait: values.wait,
    waitTimeoutMs: waitTimeoutSeconds * 1000,
    bestEffort: values["best-effort"],
    json: values.json,
  };
}

/** Renders one line per worktree with its base port and service statuses. */
function formatWorktreeList(summaries) {
  const rows = summaries.map((summary) => [
    summary.name,
    summary.branch ?? "detached",
    String(summary.basePort ?? "-"),
    ...SERVICES.map((service) => summary.services[service].status),
  ]);
  const header = [
    "NAME",
    "BRANCH",
    "PORT",
    ...SERVICES.map((service) => service.toUpperCase()),
  ];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Renders a worktree's identity and every service's status, port and URL. */
function formatWorktreeStatus(summary) {
  return [
    `${summary.name} (${summary.branch ?? "detached"})`,
    `  path: ${summary.path}`,
    ...SERVICES.map((service) => {
      const { status, port, url } = summary.services[service];
      const where = url ? ` at ${url}` : port ? ` on port ${port}` : "";
      return `  ${service}: ${status}${where}`;
    }),
  ].join("\n");
}

/**
 * Renders the outcome of a lifecycle action: each service's startup state
 * after a waited start/restart, with the error and log tail for failures and
 * the log path for services still pending at the timeout, or the refreshed
 * status after a stop or an unwaited start/restart.
 */
function formatManageResult(command, services, result) {
  const lines = [`${command} ${result.worktree.name}: ${services.join(", ")}`];
  if (!result.startup) {
    for (const service of services) {
      lines.push(`  ${service}: ${result.worktree.services[service].status}`);
    }
    return lines.join("\n");
  }
  for (const state of result.startup.services) {
    lines.push(`  ${state.service}: ${state.status}`);
    if (state.status === "failed") {
      const detail =
        state.lastError ??
        `exited with ${state.lastExitSignal ?? `code ${state.lastExitCode}`}`;
      lines.push(`    ${detail}`);
    }
    if (state.status !== "online" && state.logPath) {
      lines.push(`    log: ${state.logPath}`);
    }
    if (state.logTail) {
      lines.push(
        state.logTail
          .split("\n")
          .map((line) => `    | ${line}`)
          .join("\n"),
      );
    }
  }
  if (result.startup.timedOut) {
    lines.push(
      `  timed out after ${Math.round(result.startup.waitMs / 1000)}s waiting for services to come up; raise it with --timeout`,
    );
  }
  return lines.join("\n");
}

/**
 * Reports whether a waited start/restart left every targeted service online;
 * a stop or an unwaited start/restart counts as successful once the dashboard
 * accepted it.
 */
function manageSucceeded(result) {
  if (!result.startup) return true;
  return (
    !result.startup.timedOut &&
    result.startup.services.every((state) => state.status === "online")
  );
}

/**
 * Runs a parsed command against the dashboard and returns the process exit
 * code: 0 on success, 1 when a service failed to come up. A stop succeeds
 * when no dashboard is running, since that means no managed services.
 */
async function runCommand(options) {
  const requestTimeoutMs = options.bestEffort
    ? BEST_EFFORT_REQUEST_TIMEOUT_MS
    : undefined;

  let worktrees;
  try {
    worktrees = await fetchWorktrees({ requestTimeoutMs });
  } catch (error) {
    if (
      options.command === "stop" &&
      error instanceof DashboardUnreachableError
    ) {
      console.error(
        `No worktree dashboard at ${DASHBOARD_BASE_URL}, so no managed services to stop.`,
      );
      return 0;
    }
    throw error;
  }

  if (options.command === "list") {
    const summaries = worktrees.map(summarizeWorktree);
    console.log(
      options.json
        ? JSON.stringify(summaries, null, 2)
        : formatWorktreeList(summaries),
    );
    return 0;
  }

  const target = findWorktree(worktrees, options.worktree);

  if (options.command === "status") {
    const summary = summarizeWorktree(target);
    console.log(
      options.json
        ? JSON.stringify(summary, null, 2)
        : formatWorktreeStatus(summary),
    );
    return 0;
  }

  if (!options.json && options.wait && options.command !== "stop") {
    console.log(
      `${options.command === "restart" ? "Restarting" : "Starting"} ${options.services.join(", ")} for ${target.name}; waiting for it to come up...`,
    );
  }
  const result = await manageWorktree(
    target,
    COMMAND_ACTIONS[options.command],
    options.services,
    {
      wait: options.wait,
      waitTimeoutMs: options.waitTimeoutMs,
      requestTimeoutMs,
    },
  );
  console.log(
    options.json
      ? JSON.stringify(result, null, 2)
      : formatManageResult(options.command, options.services, result),
  );
  return manageSucceeded(result) ? 0 : 1;
}

/**
 * Parses `argv` and runs the command, returning the process exit code. With
 * --best-effort every failure is printed as a warning and the exit code is
 * 0, so the worktree pre-remove hook never blocks removal.
 */
export async function main(argv) {
  const options = parseCliArgs(argv);
  if (options.command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (!options.bestEffort) {
    return runCommand(options);
  }
  try {
    if ((await runCommand(options)) !== 0) {
      console.error(`warning: ${options.command} did not fully succeed`);
    }
  } catch (error) {
    console.error(
      `warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return 0;
}

/**
 * Reports whether this module is the process entry point. Both sides are
 * resolved to real paths because Node reports `import.meta.url` with
 * symlinks resolved while `argv[1]` keeps the path as invoked.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
