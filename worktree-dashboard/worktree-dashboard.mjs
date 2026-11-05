#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
} from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createRequestGuard, parseAllowedOrigins } from "./request-guard.mjs";
import {
  ALL_SELECTOR,
  BASE_PORT_ENV,
  basePortFromEnv,
  SERVICE_CATALOG,
  SERVICE_DEFINITIONS,
  SERVICE_TARGET_NAMES,
  SERVICES,
  serviceArgs,
  servicePortFromEnv,
  servicesForTarget,
} from "./services.mjs";
import { createStateStream } from "./state-stream.mjs";
import { createWorktree } from "./worktree-create.mjs";
import { removeWorktree } from "./worktree-remove.mjs";

function readLocalEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(process.cwd(), ".env"), "utf8")
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

const LOCAL_ENV = readLocalEnv();
const DASHBOARD_PORT = Number.parseInt(
  process.env.WORKTREE_DASHBOARD_PORT ??
    LOCAL_ENV.WORKTREE_DASHBOARD_PORT ??
    "4781",
  10,
);
const DASHBOARD_HOST =
  process.env.WORKTREE_DASHBOARD_HOST ??
  LOCAL_ENV.WORKTREE_DASHBOARD_HOST ??
  "127.0.0.1";
const DASHBOARD_ROOT = resolve(process.cwd());
const FALLBACK_PRIMARY_BRANCHES = ["develop", "main"];
let primaryBranchesPromise = null;
const checkRequest = createRequestGuard({
  dashboardHost: DASHBOARD_HOST,
  allowedOrigins: parseAllowedOrigins(
    process.env.WORKTREE_DASHBOARD_ALLOWED_ORIGINS ??
      LOCAL_ENV.WORKTREE_DASHBOARD_ALLOWED_ORIGINS,
  ),
});
const LOG_DIR = join(tmpdir(), "worktree-dashboard");
mkdirSync(LOG_DIR, { recursive: true });

/** @type {Map<string, Record<string, ServiceState>>} */
const managedServices = new Map();

let fkillModule = null;
let pidPortModule = null;

/**
 * Loads fkill on demand so dashboard startup survives dependency reinstalls.
 */
async function loadFkill() {
  if (!fkillModule) {
    fkillModule = (await import("fkill")).default;
  }
  return fkillModule;
}

/**
 * Loads pid-port on demand so read-only status endpoints can degrade during installs.
 */
async function loadPidPort() {
  if (!pidPortModule) {
    pidPortModule = await import("pid-port");
  }
  return pidPortModule;
}

/**
 * @typedef {Object} ServiceState
 * @property {import('node:child_process').ChildProcess | null} child
 * @property {number | null} pid
 * @property {boolean} running
 * @property {string | null} startedAt
 * @property {number | null} lastExitCode
 * @property {NodeJS.Signals | null} lastExitSignal
 * @property {string | null} lastError
 * @property {string | null} logPath
 * @property {import('node:fs').WriteStream | null} logStream
 */

function createServiceState() {
  return {
    child: null,
    pid: null,
    running: false,
    startedAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
    logPath: null,
    logStream: null,
  };
}

function getManagedRecord(worktreePath) {
  const existing = managedServices.get(worktreePath);
  if (existing) return existing;

  const created = Object.fromEntries(
    SERVICES.map((service) => [service, createServiceState()]),
  );
  managedServices.set(worktreePath, created);
  return created;
}

function commandForService(service) {
  const definition = SERVICE_DEFINITIONS[service];
  if (definition) {
    return definition;
  }
  throw new Error(`Unsupported service: ${service}`);
}

function workdirForService(worktreePath, commandSpec) {
  const relativeWorkdir = commandSpec.workdir ?? commandSpec.wd ?? ".";
  if (isAbsolute(relativeWorkdir)) {
    throw new Error(`Service workdir must be relative: ${relativeWorkdir}`);
  }
  const serviceWorkdir = resolve(worktreePath, relativeWorkdir);
  const relativeToRoot = relative(worktreePath, serviceWorkdir);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(
      `Service workdir must stay inside worktree: ${relativeWorkdir}`,
    );
  }
  return serviceWorkdir;
}

function formatTimestamp() {
  return new Date().toISOString();
}

function sanitizeForFilename(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function worktreeIdFromPath(worktreePath) {
  return Buffer.from(worktreePath, "utf8").toString("base64url");
}

function pathFromWorktreeId(worktreeId) {
  return Buffer.from(worktreeId, "base64url").toString("utf8");
}

function writeLogLine(state, line) {
  if (!state.logStream) return;
  state.logStream.write(`[${formatTimestamp()}] ${line}\n`);
}

function closeLogStream(state) {
  if (!state.logStream) return;
  state.logStream.end();
  state.logStream = null;
}

function serviceStateSnapshot(state) {
  return {
    pid: state.pid,
    running: state.running,
    startedAt: state.startedAt,
    lastExitCode: state.lastExitCode,
    lastExitSignal: state.lastExitSignal,
    lastError: state.lastError,
    logPath: state.logPath,
  };
}

function quoteForCmd(arg) {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[ \t"&()^|<>]/u.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function resolveSpawnCommand(command, args) {
  if (process.platform !== "win32" || !/\.cmd$/iu.test(command)) {
    return {
      command,
      args,
    };
  }

  const commandLine = [command, ...args]
    .map((part) => quoteForCmd(String(part)))
    .join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

async function startManagedService(worktreePath, service) {
  const record = getManagedRecord(worktreePath);
  const state = record[service];

  if (state.running && state.child) {
    return {
      ok: true,
      message: `${service} already running`,
      state: serviceStateSnapshot(state),
    };
  }

  const commandSpec = commandForService(service);
  const serviceWorkdir = workdirForService(worktreePath, commandSpec);
  const worktreeName = sanitizeForFilename(basename(worktreePath));
  const logPath = join(
    LOG_DIR,
    `${worktreeName}-${service}-${Date.now().toString(36)}.log`,
  );
  const logStream = createWriteStream(logPath, { flags: "a" });

  const { values: worktreeEnv } = await readEnvMap(worktreePath);
  const spawnCommand = resolveSpawnCommand(
    commandSpec.command,
    serviceArgs(service, worktreeEnv),
  );
  writeLogLine(
    { logStream },
    `Starting ${[commandSpec.command, ...serviceArgs(service, worktreeEnv)].join(" ")} in ${serviceWorkdir}`,
  );
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    cwd: serviceWorkdir,
    env: { ...process.env, ...worktreeEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });

  state.child = child;
  state.pid = child.pid ?? null;
  state.running = true;
  state.startedAt = formatTimestamp();
  state.lastExitCode = null;
  state.lastExitSignal = null;
  state.lastError = null;
  state.logPath = logPath;
  state.logStream = logStream;

  child.on("error", (error) => {
    state.lastError = error.message;
    writeLogLine(state, `Process error: ${error.message}`);
    stateStream.notify();
  });

  child.on("exit", (code, signal) => {
    state.running = false;
    state.child = null;
    state.pid = null;
    state.lastExitCode = code;
    state.lastExitSignal = signal;
    writeLogLine(
      state,
      `Exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    closeLogStream(state);
    stateStream.notify();
  });

  return {
    ok: true,
    message: `started ${service}`,
    state: serviceStateSnapshot(state),
  };
}

async function startServiceIfStopped(worktreePath, service) {
  const record = getManagedRecord(worktreePath);
  const state = record[service];

  if (state.running && state.child) {
    return {
      ok: true,
      message: `${service} already running`,
      state: serviceStateSnapshot(state),
      skipped: true,
      managed: true,
    };
  }

  const servicePort = await getServicePort(worktreePath, service);
  if (
    servicePort === null &&
    SERVICE_DEFINITIONS[service].portOffset !== undefined
  ) {
    return {
      ok: false,
      message: `${service} needs a valid ${BASE_PORT_ENV} in .env`,
      state: serviceStateSnapshot(state),
    };
  }
  if (servicePort && (await probePortOpen(servicePort))) {
    return {
      ok: true,
      message: `${service} already running (unmanaged)`,
      state: serviceStateSnapshot(state),
      skipped: true,
      managed: false,
      port: servicePort,
    };
  }

  const started = await startManagedService(worktreePath, service);
  if (!started.ok) {
    return started;
  }

  return {
    ok: true,
    message: `started ${service}`,
    state: started.state,
  };
}

async function stopManagedService(worktreePath, service) {
  const record = getManagedRecord(worktreePath);
  const state = record[service];
  let message = `${service} is not managed/running`;
  let evicted = {
    terminated: [],
    forced: [],
  };

  if (state.running && state.child) {
    writeLogLine(state, "Stopping process via SIGTERM");
    state.child.kill("SIGTERM");

    const child = state.child;
    setTimeout(() => {
      if (state.running && child) {
        writeLogLine(
          state,
          "Process did not exit after SIGTERM, sending SIGKILL",
        );
        child.kill("SIGKILL");
      }
    }, 3000);

    await waitForServiceExit(worktreePath, service, 5000);
    message = `stopped ${service}`;
  }

  const servicePort = await getServicePort(worktreePath, service);
  if (servicePort && (await probePortOpen(servicePort))) {
    evicted = await evictExternalListeners(servicePort);
    if (message !== `stopped ${service}` && evicted.terminated.length > 0) {
      message = `stopped unmanaged ${service}`;
    }
  }

  return {
    ok: true,
    message,
    state: serviceStateSnapshot(state),
    port: servicePort,
    evicted,
  };
}

function waitForServiceExit(worktreePath, service, timeoutMs = 5000) {
  const record = getManagedRecord(worktreePath);
  const state = record[service];

  if (!state.running || !state.child) {
    return Promise.resolve({ exited: true, timedOut: false });
  }

  return new Promise((resolve) => {
    const child = state.child;
    if (!child) {
      resolve({ exited: true, timedOut: false });
      return;
    }

    const finalize = (result) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            finalize({ exited: false, timedOut: true });
          }, timeoutMs);

    child.once("exit", () => {
      finalize({ exited: true, timedOut: false });
    });
  });
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readEnvMap(worktreePath) {
  const envPath = join(worktreePath, ".env");
  if (!existsSync(envPath)) {
    return { envPath, exists: false, values: {} };
  }

  const contents = await readFile(envPath, "utf8");
  /** @type {Record<string, string>} */
  const values = {};

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = parseEnvValue(trimmed.slice(equalsIndex + 1));
    values[key] = value;
  }

  return { envPath, exists: true, values };
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: DASHBOARD_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    // `close` waits for stdout to drain; `exit` can fire before it is fully read.
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function shortBranchName(fullRef) {
  if (!fullRef) return null;
  const prefix = "refs/heads/";
  if (fullRef.startsWith(prefix)) {
    return fullRef.slice(prefix.length);
  }
  return fullRef;
}

function parseWorktreeList(text) {
  const lines = text.split(/\r?\n/u);
  /** @type {Array<Record<string, string | boolean>>} */
  const worktrees = [];
  /** @type {Record<string, string | boolean> | null} */
  let current = null;

  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current?.worktree) {
        worktrees.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current?.worktree) {
        worktrees.push(current);
      }
      current = { worktree: line.slice("worktree ".length) };
      continue;
    }

    if (!current) continue;

    const firstSpace = line.indexOf(" ");
    if (firstSpace === -1) {
      current[line] = true;
      continue;
    }

    const key = line.slice(0, firstSpace);
    const value = line.slice(firstSpace + 1);
    current[key] = value;
  }

  if (current?.worktree) {
    worktrees.push(current);
  }

  return worktrees;
}

function probePortHost(port, host) {
  if (!Number.isFinite(port) || port <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({
      host,
      port,
      timeout: 300,
    });

    const finalize = (result) => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(result);
    };

    socket.on("connect", () => finalize(true));
    socket.on("timeout", () => finalize(false));
    socket.on("error", () => finalize(false));
  });
}

async function probePortOpen(port) {
  const hosts = ["127.0.0.1", "::1"];

  for (const host of hosts) {
    if (await probePortHost(port, host)) {
      return true;
    }
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getServicePort(worktreePath, service) {
  const env = await readEnvMap(worktreePath);
  return servicePortFromEnv(service, env.values);
}

/**
 * Finds the PIDs listening on a port, leaving out this process. Each lookup
 * method is tried until one finds a listener, and every attempt is recorded so
 * a busy port with no known owner can explain what was tried.
 *
 * On macOS lsof goes first because pid-port's netstat parsing finds nothing on
 * recent releases. On Linux lsof backs up pid-port: without `ss`, pid-port's own
 * lsof fallback queries TCP and UDP together and fails when no UDP socket is open.
 *
 * @param {number} port
 * @returns {Promise<{ pids: number[], attempts: string[] }>}
 */
export async function findListeningPids(port) {
  const methods = {
    darwin: [
      ["lsof", lsofListeningPids],
      ["pid-port", pidPortListeningPids],
    ],
    win32: [["pid-port", pidPortListeningPids]],
  }[process.platform] ?? [
    ["pid-port", pidPortListeningPids],
    ["lsof", lsofListeningPids],
  ];
  const attempts = [];
  for (const [name, lookup] of methods) {
    let found;
    try {
      found = await lookup(port);
    } catch (error) {
      attempts.push(`${name}: ${error?.message ?? String(error)}`);
      continue;
    }
    const pids = [...new Set(found)].filter(
      (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
    );
    if (pids.length > 0) {
      return {
        pids,
        attempts: [...attempts, `${name}: found ${pids.join(", ")}`],
      };
    }
    attempts.push(`${name}: no listeners`);
  }
  return { pids: [], attempts };
}

/** Lists listener PIDs through pid-port, treating "could not find" as none. */
async function pidPortListeningPids(port) {
  const { portBindings } = await loadPidPort();
  let bindings;
  try {
    bindings = await portBindings(port, { host: "*" });
  } catch (error) {
    if (isMissingPortBindingsError(error, port)) {
      return [];
    }
    throw error;
  }
  return bindings.map((binding) =>
    Number.parseInt(String(binding?.pid ?? ""), 10),
  );
}

/**
 * Lists listener PIDs with `lsof -t`, covering IPv4 and IPv6. lsof exits 1 with
 * no output when nothing matches, which is an empty result rather than a failure.
 */
function lsofListeningPids(port) {
  return new Promise((resolve, reject) => {
    execFile(
      "lsof",
      ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { timeout: 5000 },
      (error, stdout, stderr) => {
        const output = String(stdout).trim();
        if (error && output.length === 0 && error.code !== 1) {
          const detail = String(stderr).trim() || error.message;
          reject(new Error(`lsof failed: ${detail}`));
          return;
        }
        resolve(
          output
            .split(/\s+/u)
            .filter(Boolean)
            .map((pid) => Number.parseInt(pid, 10)),
        );
      },
    );
  });
}

function isMissingPortBindingsError(error, port) {
  if (!error || typeof error !== "object") return false;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : "";
  return (
    message.includes("could not find any processes using port") &&
    message.includes(String(port))
  );
}

async function waitForPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probePortOpen(port))) {
      return true;
    }
    await sleep(150);
  }
  return !(await probePortOpen(port));
}

function isMissingProcessError(error) {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "ESRCH") return true;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : "";
  return (
    message.includes("no process found") ||
    message.includes("couldn't find") ||
    message.includes("not found") ||
    message.includes("esrch")
  );
}

async function killPidSafe(pid, signal) {
  const fkill = await loadFkill();
  try {
    await fkill(pid, {
      force: signal === "SIGKILL",
      tree: true,
      silent: true,
    });
  } catch (error) {
    if (isMissingProcessError(error)) return;
    throw error;
  }
}

async function evictExternalListeners(port) {
  const { pids, attempts } = await findListeningPids(port);
  if (pids.length === 0) {
    if (!(await waitForPortFree(port, 1000))) {
      throw new Error(
        `Port ${port} is busy, but no listener PID was found (tried ${attempts.join("; ")})`,
      );
    }
    return {
      terminated: [],
      forced: [],
    };
  }

  for (const pid of pids) {
    await killPidSafe(pid, "SIGTERM");
  }

  let freed = await waitForPortFree(port, 4000);
  const forced = [];
  if (!freed) {
    for (const pid of pids) {
      await killPidSafe(pid, "SIGKILL");
      forced.push(pid);
    }
    freed = await waitForPortFree(port, 2000);
  }

  if (!freed) {
    throw new Error(`Port ${port} is still busy after recycle eviction`);
  }

  return {
    terminated: pids,
    forced,
  };
}

async function recycleService(worktreePath, service) {
  await stopManagedService(worktreePath, service);

  const servicePort = await getServicePort(worktreePath, service);
  if (!servicePort) {
    return startServiceIfStopped(worktreePath, service);
  }

  let evicted = {
    terminated: [],
    forced: [],
  };

  if (await probePortOpen(servicePort)) {
    evicted = await evictExternalListeners(servicePort);
  }

  const started = await startServiceIfStopped(worktreePath, service);
  return {
    ...started,
    port: servicePort,
    evicted,
  };
}

function codeCommand() {
  return process.platform === "win32" ? "code.cmd" : "code";
}

function openPathInEditor(targetPath, successMessage) {
  return new Promise((resolve, reject) => {
    const spawnCommand = resolveSpawnCommand(codeCommand(), [targetPath]);
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: DASHBOARD_ROOT,
      env: { ...process.env },
      detached: true,
      stdio: "ignore",
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("spawn", () => {
      child.unref();
      resolve({
        ok: true,
        message: successMessage,
      });
    });
  });
}

function openWorktreeInEditor(worktreePath) {
  return openPathInEditor(worktreePath, `opened editor for ${worktreePath}`);
}

function openServiceLog(worktreePath, service) {
  const record = getManagedRecord(worktreePath);
  const state = record[service];

  if (!state.logPath) {
    throw new Error(`No ${service} log file is available yet`);
  }

  if (!existsSync(state.logPath)) {
    throw new Error(`${service} log file not found: ${state.logPath}`);
  }

  return openPathInEditor(
    state.logPath,
    `opened ${service} log for ${worktreePath}`,
  );
}

/** Reports whether a process exists; only a missing-process error means it doesn't. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

/** Listener PIDs by port, reused while the process lives so lookups don't spawn lsof. */
const listenerPidCache = new Map();

/**
 * Returns the listener PID on an open port, looking it up (a subprocess) only when
 * the port has no cached PID or the cached process has exited.
 */
async function cachedListenerPid(port) {
  const cached = listenerPidCache.get(port);
  if (cached && processAlive(cached)) return cached;
  const pid = (await findListeningPids(port)).pids[0] ?? null;
  if (pid) listenerPidCache.set(port, pid);
  else listenerPidCache.delete(port);
  return pid;
}

/** The cached `git worktree list`, while the Git metadata watchers keep it fresh. */
let worktreeListPromise = null;
let worktreeMetadataWatched = false;

/**
 * Returns `git worktree list`, cached until `invalidateWorktreeList` runs, so
 * snapshots don't spawn Git each time. Without working watchers every call asks
 * Git, and a failed listing is never cached.
 */
function listWorktrees() {
  if (!worktreeMetadataWatched) invalidateWorktreeList();
  worktreeListPromise ??= runGit(["worktree", "list", "--porcelain"])
    .then(parseWorktreeList)
    .catch((error) => {
      worktreeListPromise = null;
      throw error;
    });
  return worktreeListPromise;
}

/** Drops the cached worktree list, so the next snapshot asks Git again. */
function invalidateWorktreeList() {
  worktreeListPromise = null;
}

/**
 * Combines what the dashboard knows about a service it manages with what it can
 * observe on the service's port. `reachable` means the service is doing its job:
 * its port answers, its process runs when it has no port, or a one-shot job
 * finished cleanly.
 */
async function collectServiceState(service, env, state) {
  const definition = SERVICE_DEFINITIONS[service];
  const port = servicePortFromEnv(service, env);
  const portOpen = port === null ? false : await probePortOpen(port);
  // A closed port may reopen under another process, so its cached PID can't be reused.
  if (port !== null && !portOpen) listenerPidCache.delete(port);
  const listenerPid = portOpen ? await cachedListenerPid(port) : null;
  let reachable = portOpen;
  if (definition.oneShot) {
    reachable =
      !state.running &&
      state.lastExitCode === 0 &&
      !state.lastExitSignal &&
      !state.lastError;
  } else if (definition.portOffset === undefined) {
    reachable = state.running;
  }
  return {
    ...serviceStateSnapshot(state),
    port,
    url: definition.url && port !== null ? `http://localhost:${port}` : null,
    portOpen,
    listenerPid,
    reachable,
  };
}

async function collectWorktreeState() {
  const [parsed, primaryBranches] = await Promise.all([
    listWorktrees(),
    getPrimaryBranches(),
  ]);

  const collected = await Promise.all(
    parsed.map(async (entry, index) => {
      const worktreePath = String(entry.worktree);
      const env = await readEnvMap(worktreePath);
      const branch = shortBranchName(
        typeof entry.branch === "string" ? entry.branch : null,
      );
      const record = getManagedRecord(worktreePath);
      const serviceEntries = await Promise.all(
        SERVICES.map(async (service) => [
          service,
          await collectServiceState(service, env.values, record[service]),
        ]),
      );

      return {
        id: worktreeIdFromPath(worktreePath),
        path: worktreePath,
        name: basename(worktreePath),
        branch,
        head: typeof entry.HEAD === "string" ? entry.HEAD : null,
        isMain: branch === "main",
        envPath: env.envPath,
        envExists: env.exists,
        // Git lists the primary worktree first; it and the dashboard's own checkout stay.
        canRemove: index > 0 && resolve(worktreePath) !== DASHBOARD_ROOT,
        basePort: basePortFromEnv(env.values),
        services: Object.fromEntries(serviceEntries),
      };
    }),
  );
  return sortWorktrees(collected, primaryBranches);
}

/**
 * Orders worktrees for display: primary branches first (in the order given),
 * then worktrees with a `.env` before those without, then by branch name,
 * falling back to path for detached worktrees.
 */
export function sortWorktrees(worktrees, primaryBranches) {
  const primaryRank = (worktree) => {
    const index = worktree.branch
      ? primaryBranches.indexOf(worktree.branch)
      : -1;
    return index === -1 ? primaryBranches.length : index;
  };

  return [...worktrees].sort((a, b) => {
    const rankDelta = primaryRank(a) - primaryRank(b);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    if (a.envExists !== b.envExists) {
      return a.envExists ? -1 : 1;
    }
    if (a.branch && b.branch) {
      return a.branch.localeCompare(b.branch);
    }
    return a.path.localeCompare(b.path);
  });
}

/**
 * Builds the ordered primary branch list from the remote's default branch
 * (e.g. `origin/develop`, when known) followed by the conventional
 * long-lived branches, without duplicates.
 */
export function primaryBranchesFrom(remoteHeadRef) {
  const detected = remoteHeadRef?.trim().replace(/^[^/]+\//u, "");
  return [...new Set([detected, ...FALLBACK_PRIMARY_BRANCHES].filter(Boolean))];
}

/**
 * Resolves the primary branches once per dashboard process. `origin/HEAD` is
 * only set by `git clone` or `git remote set-head`, so its absence just leaves
 * the fallback list.
 */
function getPrimaryBranches() {
  primaryBranchesPromise ??= runGit([
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ])
    .catch(() => null)
    .then(primaryBranchesFrom);
  return primaryBranchesPromise;
}

/** Writes a JSON response that browsers and proxies must not cache. */
function jsonResponse(res, statusCode, payload) {
  const encoded = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
  });
  res.end(encoded);
}

/** Writes a plain text response. */
function textResponse(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function dashboardApiInfo() {
  const uiPortRaw = Number.parseInt(
    process.env.WORKTREE_DASHBOARD_UI_PORT ?? "3031",
    10,
  );
  const uiPort = Number.isFinite(uiPortRaw) ? uiPortRaw : 3031;
  const suggestedUiUrl = `http://localhost:${uiPort}/worktree-dashboard.html`;
  return [
    "worktree dashboard API",
    `API base: http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/api`,
    `Suggested UI (via Vite): ${suggestedUiUrl}`,
  ].join("\n");
}

function parseServiceTarget(searchParams) {
  const service = searchParams.get("service") ?? ALL_SELECTOR;
  return servicesForTarget(service) ? service : null;
}

function parseLogService(searchParams) {
  const service = searchParams.get("service") ?? "backend";
  return Object.hasOwn(SERVICE_DEFINITIONS, service) ? service : null;
}

function withTargetServices(serviceTarget, handler) {
  return Promise.all(servicesForTarget(serviceTarget).map(handler));
}

async function handleServiceAction(worktreePath, action, serviceTarget) {
  if (action === "start") {
    return withTargetServices(serviceTarget, async (service) =>
      startServiceIfStopped(worktreePath, service),
    );
  }

  if (action === "stop") {
    return withTargetServices(serviceTarget, async (service) =>
      stopManagedService(worktreePath, service),
    );
  }

  if (action === "recycle") {
    return withTargetServices(serviceTarget, async (service) =>
      recycleService(worktreePath, service),
    );
  }

  throw new Error(`Unsupported action: ${action}`);
}

async function isKnownWorktreePath(worktreePath) {
  const current = await collectWorktreeState();
  return current.some((entry) => entry.path === worktreePath);
}

async function findKnownWorktree(worktreePath) {
  const current = await collectWorktreeState();
  return current.find((entry) => entry.path === worktreePath);
}

/** Parses the `force` flag that lets removal discard local changes and unmerged work. */
function parseForce(searchParams) {
  const force = searchParams.get("force");
  return force === "1" || force?.toLowerCase() === "true";
}

/**
 * Closes a removed worktree's service logs and drops its managed-process record.
 * A record with a child still running (its stop timed out) is kept, so its log
 * stream stays open for the child's output and shutdown can still kill it.
 */
function forgetManagedRecord(worktreePath) {
  const record = managedServices.get(worktreePath);
  if (!record) return;
  if (SERVICES.some((service) => record[service].running)) return;
  for (const service of SERVICES) {
    closeLogStream(record[service]);
  }
  managedServices.delete(worktreePath);
}

/** Builds the snapshot the page shows and the event stream sends. */
async function dashboardSnapshot() {
  return {
    generatedAt: formatTimestamp(),
    dashboardPid: process.pid,
    basePortEnv: BASE_PORT_ENV,
    services: SERVICE_CATALOG,
    worktrees: await collectWorktreeState(),
  };
}

const stateStream = createStateStream({
  collect: dashboardSnapshot,
  /** Checks fast while a managed service runs but isn't reachable yet, i.e. is starting. */
  needsFastChecks: (snapshot) =>
    snapshot.worktrees.some((worktree) =>
      SERVICES.some(
        (service) =>
          worktree.services[service].running &&
          !worktree.services[service].reachable,
      ),
    ),
  /** Logs a failed snapshot; the stream retries on its next timed check. */
  onError: (error) =>
    console.error("Failed to refresh the dashboard event stream:", error),
});

/**
 * Watches Git's metadata for worktrees being added or removed and for branch
 * switches (each worktree's HEAD), dropping the cached worktree list and pushing a
 * new snapshot. Index and ref updates are ignored, since they don't change the list.
 * Linked worktrees live under `<common dir>/worktrees`, which Git creates with the
 * first one, so that watch is retried whenever the top-level watch fires.
 */
async function watchWorktreeMetadata() {
  const commonDir = resolve(
    DASHBOARD_ROOT,
    (await runGit(["rev-parse", "--git-common-dir"])).trim(),
  );
  /** Invalidates the worktree list and tells the stream something changed. */
  const changed = () => {
    invalidateWorktreeList();
    stateStream.notify();
  };
  let worktreesWatcher = null;
  /**
   * (Re)starts the recursive watch on linked worktrees' metadata. Git deletes the
   * folder with the last linked worktree and recreates it with the next, and a watch
   * on a deleted folder goes silent, so each top-level event for it starts over.
   */
  const watchLinkedWorktrees = () => {
    worktreesWatcher?.close();
    worktreesWatcher = null;
    try {
      worktreesWatcher = watch(
        join(commonDir, "worktrees"),
        { recursive: true, persistent: false },
        /** Reacts to worktree folders appearing or vanishing and to HEAD changes. */
        (_event, filename) => {
          const name = String(filename ?? "").replaceAll("\\", "/");
          // `<name>` is a worktree being added or removed; `<name>/HEAD` a branch switch.
          if (!name.includes("/") || name.endsWith("/HEAD")) changed();
        },
      );
      /** Drops a broken watch; the next top-level event for the folder restarts it. */
      worktreesWatcher.on("error", () => {
        worktreesWatcher?.close();
        worktreesWatcher = null;
      });
    } catch {
      worktreesWatcher = null;
    }
  };
  watch(
    commonDir,
    { persistent: false },
    /** Follows the main worktree's HEAD and the linked-worktrees folder coming and going. */
    (_event, filename) => {
      if (filename === "worktrees") watchLinkedWorktrees();
      if (filename === "HEAD" || filename === "worktrees") changed();
    },
  );
  watchLinkedWorktrees();
  worktreeMetadataWatched = true;
}

watchWorktreeMetadata().catch((error) => {
  console.warn(
    "Could not watch Git metadata; worktree changes appear on manual refresh:",
    error,
  );
});

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const access = checkRequest({
      host: req.headers.host,
      origin: req.headers.origin,
    });
    if (!access.allowed) {
      textResponse(res, 403, access.reason ?? "Forbidden");
      return;
    }
    if (access.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", access.corsOrigin);
      res.setHeader("Vary", "Origin");
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (method === "OPTIONS") {
      if (access.corsOrigin) {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      textResponse(res, 200, dashboardApiInfo());
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/worktrees") {
      jsonResponse(res, 200, await dashboardSnapshot());
      return;
    }

    if (method === "GET" && url.pathname === "/api/events") {
      await stateStream.addClient(req, res);
      return;
    }

    if (method === "POST") {
      // Every POST can change what the snapshot shows; report it once it's answered.
      res.once("finish", () => stateStream.notify());
    }

    if (method === "POST" && url.pathname === "/api/worktrees") {
      const result = await createWorktree({
        branch: url.searchParams.get("branch") ?? "",
        root: DASHBOARD_ROOT,
      });
      invalidateWorktreeList();
      const status = result.ok ? 200 : result.reason === "invalid" ? 400 : 409;
      jsonResponse(res, status, result);
      return;
    }

    const removeMatch = url.pathname.match(
      /^\/api\/worktrees\/([^/]+)\/remove$/u,
    );

    if (method === "POST" && removeMatch) {
      const [, worktreeId] = removeMatch;
      const worktreePath = pathFromWorktreeId(worktreeId);
      const worktree = worktreePath
        ? await findKnownWorktree(worktreePath)
        : undefined;

      if (!worktree) {
        textResponse(res, 404, "Unknown worktree id");
        return;
      }
      if (!worktree.canRemove) {
        textResponse(
          res,
          400,
          "The primary worktree and the checkout running the dashboard can't be removed",
        );
        return;
      }

      const result = await removeWorktree({
        worktreePath,
        branch: worktree.branch,
        force: parseForce(url.searchParams),
        root: DASHBOARD_ROOT,
      });
      invalidateWorktreeList();
      // A failed removal can still have deleted the worktree before erroring.
      if (result.ok || !(await isKnownWorktreePath(worktreePath))) {
        forgetManagedRecord(worktreePath);
      }
      jsonResponse(res, result.ok ? 200 : 409, {
        ...result,
        action: "remove",
      });
      return;
    }

    const actionMatch = url.pathname.match(
      /^\/api\/worktrees\/([^/]+)\/(start|stop|recycle)$/u,
    );

    if (method === "POST" && actionMatch) {
      const [, worktreeId, action] = actionMatch;
      const worktreePath = pathFromWorktreeId(worktreeId);

      if (!worktreePath || !(await isKnownWorktreePath(worktreePath))) {
        textResponse(res, 404, "Unknown worktree id");
        return;
      }

      const serviceTarget = parseServiceTarget(url.searchParams);
      if (!serviceTarget) {
        textResponse(
          res,
          400,
          `service must be one of: ${SERVICE_TARGET_NAMES.join(", ")}`,
        );
        return;
      }

      const env = await readEnvMap(worktreePath);
      if (action !== "stop" && !env.exists) {
        textResponse(
          res,
          400,
          "Worktree is missing .env; run node scripts/setup-env.mjs in that worktree before managing services",
        );
        return;
      }

      const result = await handleServiceAction(
        worktreePath,
        action,
        serviceTarget,
      );

      const hasError = Array.isArray(result) && result.some((r) => !r.ok);
      const errorMessage = hasError
        ? result.find((r) => !r.ok)?.message || "Service action failed"
        : null;

      if (hasError) {
        jsonResponse(res, 400, {
          ok: false,
          action,
          service: serviceTarget,
          error: errorMessage,
          result,
        });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        action,
        service: serviceTarget,
        result,
      });
      return;
    }

    const openEditorMatch = url.pathname.match(
      /^\/api\/worktrees\/([^/]+)\/open-editor$/u,
    );

    if (method === "POST" && openEditorMatch) {
      const [, worktreeId] = openEditorMatch;
      const worktreePath = pathFromWorktreeId(worktreeId);

      if (!worktreePath || !(await isKnownWorktreePath(worktreePath))) {
        textResponse(res, 404, "Unknown worktree id");
        return;
      }

      const result = await openWorktreeInEditor(worktreePath);
      jsonResponse(res, 200, {
        ok: true,
        action: "open-editor",
        result,
      });
      return;
    }

    const openLogMatch = url.pathname.match(
      /^\/api\/worktrees\/([^/]+)\/open-log$/u,
    );

    if (method === "POST" && openLogMatch) {
      const [, worktreeId] = openLogMatch;
      const worktreePath = pathFromWorktreeId(worktreeId);

      if (!worktreePath || !(await isKnownWorktreePath(worktreePath))) {
        textResponse(res, 404, "Unknown worktree id");
        return;
      }

      const service = parseLogService(url.searchParams);
      if (!service) {
        textResponse(
          res,
          400,
          `service must be one of: ${SERVICES.join(", ")}`,
        );
        return;
      }

      const result = await openServiceLog(worktreePath, service);
      jsonResponse(res, 200, {
        ok: true,
        action: "open-log",
        service,
        result,
      });
      return;
    }

    textResponse(res, 404, "Not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    textResponse(res, 500, message);
  }
});

server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  const url = `http://${DASHBOARD_HOST}:${server.address().port}`;
  console.log(`worktree dashboard listening on ${url}`);
  console.log(`API endpoint: ${url}/api/worktrees`);
  console.log(
    "Start Vite and open /worktree-dashboard.html for the Solid dashboard UI.",
  );
  console.log("Use Ctrl+C to stop this API and any managed child processes.");
});

function shutdown(signal) {
  console.log(`Received ${signal}, stopping managed processes...`);
  stateStream.close();

  for (const [worktreePath, services] of managedServices.entries()) {
    for (const service of SERVICES) {
      const state = services[service];
      if (state.running && state.child) {
        writeLogLine(
          state,
          `Dashboard received ${signal}; terminating child process`,
        );
        state.child.kill("SIGTERM");
      }
      closeLogStream(state);
    }
    managedServices.delete(worktreePath);
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 1500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
