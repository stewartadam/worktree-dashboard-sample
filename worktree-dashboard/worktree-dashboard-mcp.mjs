#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DASHBOARD_BASE_URL,
  fetchWorktrees,
  findWorktree,
  MANAGE_ACTIONS,
  manageWorktree,
  resolveWorktreeServiceTargets,
  summarizeWorktree,
  uniqueNonEmptyStrings,
} from "./dashboard-client.mjs";
import { ALL_SELECTOR, SERVICE_TARGET_NAMES } from "./services.mjs";

const SERVER_NAME = "worktree-dashboard";
const SERVER_VERSION = "0.1.0";
const DEBUG_LOG_PATH =
  process.env.WORKTREE_DASHBOARD_MCP_DEBUG_LOG?.trim() || null;

const TOOLS = [
  {
    name: "dashboard_list_worktrees",
    description: "List all worktrees discovered by the worktree dashboard.",
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
            enum: SERVICE_TARGET_NAMES,
          },
          minItems: 1,
          description: "Service targets. Defaults to [all], every service.",
          default: [ALL_SELECTOR],
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
    const serviceModes = uniqueNonEmptyStrings(args.services ?? [ALL_SELECTOR]);
    const services = resolveWorktreeServiceTargets(serviceModes);
    if (!worktreePath) {
      throw new Error("worktree is required");
    }
    if (!MANAGE_ACTIONS.includes(action)) {
      throw new Error("action must be one of: start, stop, recycle");
    }
    if (serviceModes.length === 0) {
      throw new Error("services must contain at least one target");
    }
    if (
      !serviceModes.every((service) => SERVICE_TARGET_NAMES.includes(service))
    ) {
      throw new Error(
        `services must contain only: ${SERVICE_TARGET_NAMES.join(", ")}`,
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
