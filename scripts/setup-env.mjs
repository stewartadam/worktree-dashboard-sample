#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sharedBrowsersPath } from "./playwright-path.mjs";

function commandFor(base) {
  if (process.platform === "win32") {
    return `${base}.exe`;
  }
  return base;
}

function randomPort() {
  return 3000 + Math.floor(Math.random() * 1000);
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
    child.on("exit", (code, signal) => {
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

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(scriptDir);
  const envFile = join(projectRoot, ".env");

  const portRaw = process.env.WORKTREE_APP_PORT?.trim();
  const port =
    portRaw && Number.isFinite(Number(portRaw))
      ? Number.parseInt(portRaw, 10)
      : randomPort();

  const branchName = await detectBranchName();
  const appTitle = `Sample Worktree App (${branchName})`;

  await writeFile(
    envFile,
    `WORKTREE_APP_PORT=${port}\nVITE_APP_TITLE=${appTitle}\nPLAYWRIGHT_BROWSERS_PATH=${sharedBrowsersPath}\n`,
    "utf8",
  );
  process.stdout.write(
    `OK: Generated ${envFile} with WORKTREE_APP_PORT=${port}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
