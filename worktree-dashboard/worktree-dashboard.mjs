#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

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
const DASHBOARD_ROOT = process.cwd();
const LOG_DIR = join(tmpdir(), "worktree-dashboard");
const SERVICE_DEFINITIONS = {
  backend: {
    command: process.platform === "win32" ? "cargo.exe" : "cargo",
    workdir: "./src-tauri",
    args: ["run"],
    label: "cargo run",
  },
  ui: {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "dev"],
    label: "npm run dev",
  },
};
const SERVICES = Object.keys(SERVICE_DEFINITIONS);
const PORT_SCOPED_SERVICES = new Set(["backend", "ui"]);

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

async function processEnvForService(worktreePath) {
  const env = await readEnvMap(worktreePath);
  return { ...process.env, ...env.values };
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

  writeLogLine(
    { logStream },
    `Starting ${commandSpec.label} in ${serviceWorkdir}`,
  );

  const spawnCommand = resolveSpawnCommand(
    commandSpec.command,
    commandSpec.args,
  );
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    cwd: serviceWorkdir,
    env: await processEnvForService(worktreePath),
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

    child.on("exit", (code) => {
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
  if (!PORT_SCOPED_SERVICES.has(service)) {
    return null;
  }

  const env = await readEnvMap(worktreePath);
  const backendPortRaw = env.values.WORKTREE_APP_PORT;
  const backendPort = backendPortRaw
    ? Number.parseInt(backendPortRaw, 10)
    : Number.NaN;
  if (!Number.isFinite(backendPort)) {
    return null;
  }

  if (service === "backend") {
    return backendPort;
  }
  return backendPort + 1;
}

async function findListeningPids(port) {
  const { portBindings } = await loadPidPort();
  let bindings = [];
  try {
    bindings = await portBindings(port, { host: "*" });
  } catch (error) {
    if (isMissingPortBindingsError(error, port)) {
      return [];
    }
    throw error;
  }
  const pids = new Set();
  for (const binding of bindings) {
    const pid = Number.parseInt(String(binding?.pid ?? ""), 10);
    if (!Number.isFinite(pid)) continue;
    if (pid === process.pid) continue;
    pids.add(pid);
  }
  return [...pids];
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
  const pids = await findListeningPids(port);
  if (pids.length === 0) {
    if (!(await waitForPortFree(port, 1000))) {
      throw new Error(
        `Port ${port} is busy, but no owning process could be resolved`,
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

async function collectWorktreeState() {
  const raw = await runGit(["worktree", "list", "--porcelain"]);
  const parsed = parseWorktreeList(raw);
  let pidByPort = new Map();
  try {
    const { allPortsWithPid } = await loadPidPort();
    pidByPort = await allPortsWithPid({ host: "*" });
  } catch {
    pidByPort = new Map();
  }

  const collected = await Promise.all(
    parsed.map(async (entry) => {
      const worktreePath = String(entry.worktree);
      const env = await readEnvMap(worktreePath);
      const branch = shortBranchName(
        typeof entry.branch === "string" ? entry.branch : null,
      );
      const backendPortRaw = env.values.WORKTREE_APP_PORT;
      const parsedBackendPort = backendPortRaw
        ? Number.parseInt(backendPortRaw, 10)
        : Number.NaN;
      const backendPort = Number.isFinite(parsedBackendPort)
        ? parsedBackendPort
        : null;
      const webUiPort = backendPort === null ? null : backendPort + 1;
      const [backendPortOpen, webUiPortOpen] = await Promise.all([
        backendPort ? probePortOpen(backendPort) : Promise.resolve(false),
        webUiPort ? probePortOpen(webUiPort) : Promise.resolve(false),
      ]);
      const [backendPid, webUiPid] = await Promise.all([
        backendPort && backendPortOpen
          ? Promise.resolve(pidByPort.get(backendPort) ?? null)
          : Promise.resolve(null),
        webUiPort && webUiPortOpen
          ? Promise.resolve(pidByPort.get(webUiPort) ?? null)
          : Promise.resolve(null),
      ]);
      const record = getManagedRecord(worktreePath);

      return {
        id: worktreeIdFromPath(worktreePath),
        path: worktreePath,
        name: basename(worktreePath),
        branch,
        head: typeof entry.HEAD === "string" ? entry.HEAD : null,
        isMain: branch === "main",
        envPath: env.envPath,
        envExists: env.exists,
        backendPort: backendPort,
        webUiPort,
        webUiUrl: webUiPort ? `http://localhost:${webUiPort}` : null,
        managed: {
          backend: serviceStateSnapshot(record.backend),
          ui: serviceStateSnapshot(record.ui),
        },
        observed: {
          backendPortOpen,
          webUiPortOpen,
          backendPid,
          webUiPid,
        },
      };
    }),
  );
  const worktrees = collected;

  worktrees.sort((a, b) => {
    if (a.isMain !== b.isMain) {
      return a.isMain ? -1 : 1;
    }
    if (a.envExists !== b.envExists) {
      return a.envExists ? -1 : 1;
    }
    if (a.branch && b.branch) {
      return a.branch.localeCompare(b.branch);
    }
    return a.path.localeCompare(b.path);
  });

  return worktrees;
}

/** Returns headers shared by all dashboard API responses. */
function responseHeaders(extraHeaders = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  };
}

/** Writes a JSON response with cache and CORS headers. */
function jsonResponse(res, statusCode, payload) {
  const encoded = JSON.stringify(payload);
  res.writeHead(
    statusCode,
    responseHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(encoded),
      "Cache-Control": "no-store",
    }),
  );
  res.end(encoded);
}

/** Writes a plain text response with CORS headers. */
function textResponse(res, statusCode, text) {
  res.writeHead(
    statusCode,
    responseHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    }),
  );
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
  const service = searchParams.get("service") ?? "both";
  if (
    service === "all" ||
    service === "both" ||
    service === "backend" ||
    service === "ui"
  ) {
    return service;
  }
  return null;
}

function parseLogService(searchParams) {
  const service = searchParams.get("service") ?? "backend";
  if (service === "backend" || service === "ui") {
    return service;
  }
  return null;
}

async function withTargetServices(serviceTarget, handler) {
  if (serviceTarget === "all") {
    return Promise.all([handler("backend"), handler("ui")]);
  }
  if (serviceTarget === "both") {
    return Promise.all([handler("backend"), handler("ui")]);
  }
  return [await handler(serviceTarget)];
}

async function handleServiceAction(
  worktreePath,
  action,
  serviceTarget,
) {
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

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (method === "OPTIONS") {
      res.writeHead(204, responseHeaders());
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
      const worktrees = await collectWorktreeState();
      jsonResponse(res, 200, {
        generatedAt: formatTimestamp(),
        dashboardPid: process.pid,
        worktrees,
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
          "service must be one of: all, backend, ui, both",
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
        textResponse(res, 400, "service must be one of: backend, ui");
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
  const url = `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`;
  console.log(`worktree dashboard listening on ${url}`);
  console.log(`API endpoint: ${url}/api/worktrees`);
  console.log(
    "Start Vite and open /worktree-dashboard.html for the Solid dashboard UI.",
  );
  console.log("Use Ctrl+C to stop this API and any managed child processes.");
});

function shutdown(signal) {
  console.log(`Received ${signal}, stopping managed processes...`);

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
