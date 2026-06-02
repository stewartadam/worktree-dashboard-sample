#!/usr/bin/env node

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SERVER_NAME = "worktree-dashboard";
const SERVER_VERSION = "0.1.0";
function readLocalEnv() {
  try {
    return Object.fromEntries(
      readFileSync(resolve(process.cwd(), ".env"), "utf8")
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
const DASHBOARD_BASE_URL = (
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
const DEBUG_LOG_PATH =
  process.env.WORKTREE_DASHBOARD_MCP_DEBUG_LOG?.trim() || null;
const WORKTREE_MANAGED_SERVICES = ["backend", "ui"];
const ALL_SELECTOR = "all";

const TOOLS = [
  {
    name: "dashboard_list_worktrees",
    description:
      "List all worktrees discovered by the worktree dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description:
            "Include the full dashboard payload for each worktree instead of a summarized view.",
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dashboard_worktree_status",
    description:
      "Get runtime status for a specific worktree managed by the dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        worktree: {
          type: "string",
          description:
            "Worktree path exactly as shown by dashboard_list_worktrees.",
        },
      },
      required: ["worktree"],
      additionalProperties: false,
    },
  },
  {
    name: "dashboard_worktree_manage",
    description:
      "Start, stop, or recycle managed services for a specific worktree.",
    inputSchema: {
      type: "object",
      properties: {
        worktree: {
          type: "string",
          description:
            "Worktree path exactly as shown by dashboard_list_worktrees.",
        },
        action: {
          type: "string",
          enum: ["start", "stop", "recycle"],
          description: "Lifecycle action to run.",
        },
        services: {
          type: "array",
          items: {
            type: "string",
            enum: [...WORKTREE_MANAGED_SERVICES, ALL_SELECTOR],
          },
          minItems: 1,
          description:
            "Service targets. Defaults to [backend, ui]. Use [all] to target both services.",
          default: ["backend", "ui"],
        },
      },
      required: ["worktree", "action"],
      additionalProperties: false,
    },
  },
];

let inboundBuffer = Buffer.alloc(0);
let transportMode = "unknown";

process.stdin.on("data", (chunk) => {
  logDebugRawChunk(chunk);
  inboundBuffer = Buffer.concat([inboundBuffer, chunk]);
  drainIncomingMessages();
});

process.stdin.on("error", (error) => {
  logError(error);
});

process.stdin.resume();

function logDebug(event, payload) {
  if (!DEBUG_LOG_PATH) return;
  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    appendFileSync(
      DEBUG_LOG_PATH,
      `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`,
      "utf8",
    );
  } catch {
    // Intentionally ignore debug log write failures.
  }
}

function logDebugRawChunk(chunk) {
  if (!DEBUG_LOG_PATH) return;
  const text = chunk.toString("utf8");
  const escaped = text
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  const previewLimit = 4000;
  logDebug("stdin-chunk", {
    bytes: chunk.length,
    preview: escaped.slice(0, previewLimit),
    truncated: escaped.length > previewLimit,
  });
}

function logDebugJsonRpc(direction, message) {
  if (!DEBUG_LOG_PATH) return;
  const summary = {
    jsonrpc: message?.jsonrpc,
    id: message?.id ?? null,
    method: message?.method ?? null,
    hasResult: Object.hasOwn(message ?? {}, "result"),
    hasError: Object.hasOwn(message ?? {}, "error"),
    paramsKeys:
      message?.params && typeof message.params === "object"
        ? Object.keys(message.params)
        : [],
  };
  logDebug(direction, summary);
}

function normalizePath(pathValue) {
  const resolved = resolve(pathValue);
  try {
    const real = realpathSync.native(resolved);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

function writeProtocolMessage(message) {
  logDebugJsonRpc("stdout-message", message);
  const payload = JSON.stringify(message);
  if (transportMode === "line") {
    process.stdout.write(`${payload}\n`);
    return;
  }
  const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
  process.stdout.write(header);
  process.stdout.write(payload);
}

function sendJsonRpcResult(id, result) {
  writeProtocolMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendJsonRpcError(id, code, message, data) {
  const payload = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
  if (data !== undefined) {
    payload.error.data = data;
  }
  writeProtocolMessage(payload);
}

function parseHeaders(headerText) {
  const headerMap = new Map();
  for (const line of headerText.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headerMap.set(key, value);
  }
  return headerMap;
}

function findHeaderBoundary(buffer) {
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  const lfBoundary = buffer.indexOf("\n\n");

  if (crlfBoundary === -1 && lfBoundary === -1) {
    return null;
  }

  if (crlfBoundary === -1) {
    return { index: lfBoundary, length: 2 };
  }

  if (lfBoundary === -1) {
    return { index: crlfBoundary, length: 4 };
  }

  if (crlfBoundary < lfBoundary) {
    return { index: crlfBoundary, length: 4 };
  }

  return { index: lfBoundary, length: 2 };
}

function maybeDetectFramedTransport(buffer) {
  const probe = buffer
    .subarray(0, Math.min(buffer.length, 64))
    .toString("utf8");
  return /^content-length\s*:/iu.test(probe);
}

function drainIncomingMessages() {
  while (true) {
    const headerBoundary = findHeaderBoundary(inboundBuffer);
    if (headerBoundary) {
      transportMode = transportMode === "unknown" ? "framed" : transportMode;

      const headerText = inboundBuffer
        .subarray(0, headerBoundary.index)
        .toString("utf8");
      const headers = parseHeaders(headerText);
      const contentLengthRaw = headers.get("content-length");
      const contentLength = contentLengthRaw
        ? Number.parseInt(contentLengthRaw, 10)
        : Number.NaN;

      if (!Number.isFinite(contentLength) || contentLength < 0) {
        inboundBuffer = Buffer.alloc(0);
        sendJsonRpcError(null, -32700, "Invalid Content-Length header");
        return;
      }

      const contentStart = headerBoundary.index + headerBoundary.length;
      const frameLength = contentStart + contentLength;
      if (inboundBuffer.length < frameLength) {
        return;
      }

      const body = inboundBuffer
        .subarray(contentStart, frameLength)
        .toString("utf8");
      inboundBuffer = inboundBuffer.subarray(frameLength);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        sendJsonRpcError(null, -32700, "Invalid JSON payload");
        continue;
      }

      logDebugJsonRpc("stdin-message", message);

      void handleJsonRpcMessage(message);
      continue;
    }

    if (maybeDetectFramedTransport(inboundBuffer)) {
      return;
    }

    const lineBreakIndex = inboundBuffer.indexOf("\n");
    if (lineBreakIndex === -1) {
      return;
    }

    const line = inboundBuffer.subarray(0, lineBreakIndex).toString("utf8");
    inboundBuffer = inboundBuffer.subarray(lineBreakIndex + 1);

    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    transportMode = transportMode === "unknown" ? "line" : transportMode;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      sendJsonRpcError(null, -32700, "Invalid JSON payload");
      continue;
    }

    logDebugJsonRpc("stdin-message", message);

    void handleJsonRpcMessage(message);
  }
}

async function handleJsonRpcMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (!("method" in message) || typeof message.method !== "string") {
    return;
  }

  const hasId = Object.hasOwn(message, "id");
  const id = hasId ? message.id : null;

  try {
    if (message.method === "initialize") {
      if (!hasId) return;
      sendJsonRpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (message.method === "notifications/initialized") {
      return;
    }

    if (message.method === "ping") {
      if (!hasId) return;
      sendJsonRpcResult(id, {});
      return;
    }

    if (message.method === "tools/list") {
      if (!hasId) return;
      sendJsonRpcResult(id, { tools: TOOLS });
      return;
    }

    if (message.method === "tools/call") {
      if (!hasId) return;
      const params = message.params ?? {};
      const name = params.name;
      const args = params.arguments ?? {};

      if (typeof name !== "string") {
        sendJsonRpcError(id, -32602, "tools/call params.name must be a string");
        return;
      }

      const result = await runTool(name, args);
      sendJsonRpcResult(id, result);
      return;
    }

    if (message.method === "$/cancelRequest") {
      return;
    }

    if (hasId) {
      sendJsonRpcError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);

    if (message.method === "tools/call" && hasId) {
      sendJsonRpcResult(id, {
        content: [{ type: "text", text: messageText }],
        isError: true,
      });
      return;
    }

    if (hasId) {
      sendJsonRpcError(id, -32603, messageText);
    } else {
      logError(error);
    }
  }
}

function asTextToolResult(text, structuredContent) {
  const result = {
    content: [{ type: "text", text }],
  };
  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent;
  }
  return result;
}

function statusSummary(worktree, service) {
  const managedState = worktree.managed?.[service];
  const observedOpen = observedOpenForService(worktree, service);

  if (managedState?.running && observedOpen) return "managed + reachable";
  if (managedState?.running && !observedOpen)
    return "managed starting/unreachable";
  if (!managedState?.running && observedOpen)
    return "external process detected";
  return "stopped";
}

function summarizeWorktree(worktree) {
  return {
    id: worktree.id,
    path: worktree.path,
    name: worktree.name,
    branch: worktree.branch,
    backendPort: worktree.backendPort,
    webUiPort: worktree.webUiPort,
    webUiUrl: worktree.webUiUrl,
    backend: statusSummary(worktree, "backend"),
    ui: statusSummary(worktree, "ui"),
    managed: {
      backend: {
        running: Boolean(worktree.managed?.backend?.running),
        pid: worktree.managed?.backend?.pid ?? null,
      },
      ui: {
        running: Boolean(worktree.managed?.ui?.running),
        pid: worktree.managed?.ui?.pid ?? null,
      },
    },
  };
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function uniqueNonEmptyStrings(values) {
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

function resolveWorktreeServiceTargets(values) {
  const targets = uniqueNonEmptyStrings(values);
  if (targets.includes(ALL_SELECTOR)) {
    return [...WORKTREE_MANAGED_SERVICES];
  }
  return targets;
}

function observedOpenForService(worktree, service) {
  if (service === "backend") {
    return Boolean(worktree.observed?.backendPortOpen);
  }
  if (service === "ui") {
    return Boolean(worktree.observed?.webUiPortOpen);
  }
  return false;
}

function classifyStartup(worktree, service) {
  const managed = worktree.managed?.[service] ?? null;
  const observedOpen = observedOpenForService(worktree, service);
  if (observedOpen) {
    return {
      service,
      status: "online",
      pid: managed?.pid ?? null,
      logPath: managed?.logPath ?? null,
      lastExitCode: managed?.lastExitCode ?? null,
      lastExitSignal: managed?.lastExitSignal ?? null,
      lastError: managed?.lastError ?? null,
    };
  }

  if (managed?.running) {
    return {
      service,
      status: "pending",
      pid: managed?.pid ?? null,
      logPath: managed?.logPath ?? null,
      lastExitCode: managed?.lastExitCode ?? null,
      lastExitSignal: managed?.lastExitSignal ?? null,
      lastError: managed?.lastError ?? null,
    };
  }

  if ((managed?.lastExitCode ?? null) !== null || managed?.lastError) {
    return {
      service,
      status: "failed",
      pid: managed?.pid ?? null,
      logPath: managed?.logPath ?? null,
      lastExitCode: managed?.lastExitCode ?? null,
      lastExitSignal: managed?.lastExitSignal ?? null,
      lastError: managed?.lastError ?? null,
    };
  }

  return {
    service,
    status: "pending",
    pid: managed?.pid ?? null,
    logPath: managed?.logPath ?? null,
    lastExitCode: managed?.lastExitCode ?? null,
    lastExitSignal: managed?.lastExitSignal ?? null,
    lastError: managed?.lastError ?? null,
  };
}

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

async function waitForStartupOutcome(worktreePath, services) {
  const targets = uniqueNonEmptyStrings(services);
  const startedAt = Date.now();
  let latest = findWorktree(await fetchWorktrees(), worktreePath);

  while (Date.now() - startedAt < STARTUP_WAIT_TIMEOUT_MS) {
    const states = targets.map((target) => classifyStartup(latest, target));
    const complete = states.every(
      (state) => state.status === "online" || state.status === "failed",
    );
    if (complete) {
      const enrichedStates = await Promise.all(
        states.map(async (state) => ({
          ...state,
          logTail:
            state.status === "failed" ? await readLogTail(state.logPath) : null,
        })),
      );
      return {
        timedOut: false,
        waitMs: Date.now() - startedAt,
        services: enrichedStates,
        worktree: latest,
      };
    }

    await delay(STARTUP_POLL_INTERVAL_MS);
    latest = findWorktree(await fetchWorktrees(), worktreePath);
  }

  const timeoutStates = targets.map((target) =>
    classifyStartup(latest, target),
  );
  const enrichedTimeoutStates = await Promise.all(
    timeoutStates.map(async (state) => ({
      ...state,
      logTail:
        state.status === "failed" ? await readLogTail(state.logPath) : null,
    })),
  );
  return {
    timedOut: true,
    waitMs: Date.now() - startedAt,
    services: enrichedTimeoutStates,
    worktree: latest,
  };
}

async function fetchDashboard(path, options) {
  const url = `${DASHBOARD_BASE_URL}${path}`;
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(DASHBOARD_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      throw new Error(
        `Worktree dashboard request timed out after ${DASHBOARD_REQUEST_TIMEOUT_MS}ms: ${url}`,
        { cause: error },
      );
    }
    throw new Error(
      `Unable to reach worktree dashboard at ${DASHBOARD_BASE_URL}. Start it with: npm run worktree:dashboard`,
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

async function fetchWorktrees() {
  const raw = await fetchDashboard("/api/worktrees");
  const payload = JSON.parse(raw);
  if (!payload || !Array.isArray(payload.worktrees)) {
    throw new Error("Dashboard payload is missing worktrees");
  }
  return payload.worktrees;
}

function findWorktree(worktrees, worktreePath) {
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

async function manageWorktree(worktreePath, action, services) {
  const worktrees = await fetchWorktrees();
  const current = findWorktree(worktrees, worktreePath);
  const targets = uniqueNonEmptyStrings(services);
  const actionResults = await Promise.all(
    targets.map(async (targetService) => {
      const raw = await fetchDashboard(
        `/api/worktrees/${encodeURIComponent(current.id)}/${encodeURIComponent(action)}?service=${encodeURIComponent(targetService)}`,
        { method: "POST" },
      );
      return {
        service: targetService,
        result: JSON.parse(raw),
      };
    }),
  );
  let startup = null;
  let refreshed = findWorktree(await fetchWorktrees(), worktreePath);
  if (action === "start" || action === "recycle") {
    const startupOutcome = await waitForStartupOutcome(worktreePath, targets);
    refreshed = startupOutcome.worktree;
    startup = {
      timedOut: startupOutcome.timedOut,
      waitMs: startupOutcome.waitMs,
      services: startupOutcome.services,
    };
  }

  return {
    worktree: summarizeWorktree(refreshed),
    action: actionResults,
    startup,
  };
}

async function runTool(name, args) {
  if (name === "dashboard_list_worktrees") {
    const verbose = Boolean(args.verbose);
    const worktrees = await fetchWorktrees();
    const payload = verbose ? worktrees : worktrees.map(summarizeWorktree);
    return asTextToolResult(JSON.stringify(payload, null, 2), {
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      worktrees: payload,
    });
  }

  if (name === "dashboard_worktree_status") {
    const worktreePath = String(args.worktree ?? "");
    if (!worktreePath) {
      throw new Error("worktree is required");
    }

    const target = findWorktree(await fetchWorktrees(), worktreePath);
    const summary = summarizeWorktree(target);
    return asTextToolResult(JSON.stringify(summary, null, 2), {
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      worktree: summary,
    });
  }

  if (name === "dashboard_worktree_manage") {
    const worktreePath = String(args.worktree ?? "");
    const action = String(args.action ?? "");
    const serviceModes = uniqueNonEmptyStrings(
      args.services ?? ["backend", "ui"],
    );
    const services = resolveWorktreeServiceTargets(serviceModes);
    if (!worktreePath) {
      throw new Error("worktree is required");
    }
    if (!["start", "stop", "recycle"].includes(action)) {
      throw new Error("action must be one of: start, stop, recycle");
    }
    if (serviceModes.length === 0) {
      throw new Error("services must contain at least one target");
    }
    if (
      !serviceModes.every(
        (service) =>
          WORKTREE_MANAGED_SERVICES.includes(service) ||
          service === ALL_SELECTOR,
      )
    ) {
      throw new Error(
        "services must contain only: backend, ui, all",
      );
    }

    const payload = await manageWorktree(worktreePath, action, services);
    return asTextToolResult(JSON.stringify(payload, null, 2), {
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      ...payload,
    });
  }

  throw new Error(`Unknown tool: ${name}`);
}

function logError(error) {
  const text =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${text}\n`);
}
