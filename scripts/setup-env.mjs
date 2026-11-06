#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { BASE_PORT_ENV } from "../worktree-dashboard/services.mjs";
import { sharedBrowsersPath } from "./playwright-path.mjs";

function commandFor(base) {
  if (process.platform === "win32") {
    return `${base}.exe`;
  }
  return base;
}

const PORT_RANGE_START = 3000;
/**
 * Ports reserved per worktree, starting at the base port. Each service in
 * `worktree-dashboard/services.mjs` listens at an offset inside the block.
 */
export const PORT_BLOCK_SIZE = 10;
const PORT_BLOCK_COUNT = 100;

/**
 * Picks a random port block in 3000-3999 whose ports no other worktree uses.
 * Blocks are aligned to PORT_BLOCK_SIZE so ports read as worktree base plus
 * service offset. Each taken port is assumed to own a full block starting at
 * it, which also covers older worktrees whose ports are not aligned.
 */
export function pickPortBlock(takenPorts, random = Math.random) {
  const free = [];
  for (let block = 0; block < PORT_BLOCK_COUNT; block += 1) {
    const base = PORT_RANGE_START + block * PORT_BLOCK_SIZE;
    const overlaps = takenPorts.some(
      (taken) =>
        taken < base + PORT_BLOCK_SIZE && base < taken + PORT_BLOCK_SIZE,
    );
    if (!overlaps) free.push(base);
  }
  if (free.length === 0) {
    throw new Error(
      `No free ${PORT_BLOCK_SIZE}-port block between ${PORT_RANGE_START} and ${PORT_RANGE_START + PORT_BLOCK_SIZE * PORT_BLOCK_COUNT - 1}; set ${BASE_PORT_ENV} explicitly`,
    );
  }
  return free[Math.floor(random() * free.length)];
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
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
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

async function detectBranchName() {
  try {
    const git = commandFor("git");
    const raw = await runCapture(git, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = raw.trim();
    if (branch.length > 0) {
      return branch;
    }
  } catch {
    // Ignore and use cwd basename fallback.
  }
  return basename(process.cwd());
}

/**
 * Lists the base port of every other worktree of this repository that
 * has a `.env`, so a new worktree can avoid their ports.
 */
async function otherWorktreePorts(projectRoot) {
  let listing = "";
  try {
    listing = await runCapture(commandFor("git"), [
      "-C",
      projectRoot,
      "worktree",
      "list",
      "--porcelain",
    ]);
  } catch {
    return [];
  }
  const paths = listing
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .filter((path) => path !== resolve(projectRoot));
  const ports = await Promise.all(
    paths.map(async (path) => {
      try {
        const env = parseEnv(await readFile(join(path, ".env"), "utf8"));
        return Number.parseInt(env[BASE_PORT_ENV] ?? "", 10);
      } catch {
        return Number.NaN;
      }
    }),
  );
  return ports.filter(Number.isFinite);
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(scriptDir);
  const envFile = join(projectRoot, ".env");

  const portRaw = process.env[BASE_PORT_ENV]?.trim();
  const port =
    portRaw && Number.isFinite(Number(portRaw))
      ? Number.parseInt(portRaw, 10)
      : pickPortBlock(await otherWorktreePorts(projectRoot));

  const branchName = await detectBranchName();
  const appTitle = `Sample App (${branchName})`;

  await writeFile(
    envFile,
    `${BASE_PORT_ENV}=${port}\nVITE_APP_TITLE=${appTitle}\nPLAYWRIGHT_BROWSERS_PATH=${sharedBrowsersPath}\n`,
    "utf8",
  );
  process.stdout.write(
    `OK: Generated ${envFile} with ${BASE_PORT_ENV}=${port}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
