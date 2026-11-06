import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKTREE_DONE_SCRIPT = fileURLToPath(
  new URL("../scripts/worktree-done.mjs", import.meta.url),
);
const MAX_REPORTED_DETAILS = 10;
// `wt done` fetches origin and may ask GitHub for the branch's PR.
const REMOVAL_TIMEOUT_MS = 120_000;

/**
 * @typedef {object} ProcessResult
 * @property {number} code Exit code, or 1 when the process ended on a signal.
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {(command: string, args: string[], options: { cwd: string, timeoutMs?: number }) => Promise<ProcessResult>} ProcessRunner
 */

/**
 * @typedef {object} RemoveWorktreeResult
 * @property {boolean} ok
 * @property {"local-changes" | "unmerged" | "failed" | undefined} reason Why removal was refused.
 * @property {string} message One-line summary suited to a toast.
 * @property {string[]} details Changed file paths or unmerged commits behind a refusal,
 *   capped at the first few with a trailing "…and N more" line.
 * @property {number} total How many changed files or unmerged commits there are in all.
 */

/**
 * Runs a command to completion without a shell and collects its output instead of
 * rejecting on a non-zero exit, so callers can classify refusals from the output.
 * A command still running after `timeoutMs` is terminated and reported as failed.
 *
 * @type {ProcessRunner}
 */
export function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const stopped =
        signal && timeoutMs
          ? `\n${command} did not finish within ${timeoutMs / 1000}s`
          : "";
      resolve({ code: code ?? 1, stdout, stderr: `${stderr}${stopped}` });
    });
  });
}

/** Returns the platform-specific Worktrunk executable name. */
function worktreeCommand() {
  return process.platform === "win32" ? "wt.exe" : "wt";
}

/** Joins a process's stdout and stderr into one trimmed block for error messages. */
function combinedOutput(result) {
  return [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
}

/**
 * Keeps refusal details short enough for a toast, noting how many were left
 * out, and returns the full count alongside.
 */
function limitDetails(lines) {
  const trimmed = lines.map((line) => line.trim()).filter(Boolean);
  const details =
    trimmed.length <= MAX_REPORTED_DETAILS
      ? trimmed
      : [
          ...trimmed.slice(0, MAX_REPORTED_DETAILS),
          `…and ${trimmed.length - MAX_REPORTED_DETAILS} more`,
        ];
  return { details, total: trimmed.length };
}

/** Builds the result for a removal that went through. */
function removed(target) {
  return { ok: true, message: `Removed ${target}`, details: [], total: 0 };
}

/** Builds the result for a command that failed for a reason the dashboard can't classify. */
function failed(result, fallback) {
  const output = combinedOutput(result);
  return {
    ok: false,
    reason: "failed",
    message: output.split("\n").at(-1) || fallback,
    ...limitDetails(output.split("\n")),
  };
}

/**
 * Parses `wt done` output for a branch it kept, returning the stated reason and the
 * unmerged commits listed under it, or null when the branch was not kept.
 */
export function parseKeptBranch(output, branch) {
  const lines = output.split("\n");
  const prefix = `Kept ${branch}: `;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index === -1) return null;
  const commits = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === "Unmerged commits:") continue;
    if (!line.startsWith("    ")) break;
    commits.push(line);
  }
  return { reason: lines[index].slice(prefix.length), commits };
}

/**
 * Removes a secondary worktree through Worktrunk, so its pre-remove hook stops the
 * worktree's services first.
 *
 * A normal removal refuses a worktree with uncommitted or untracked files, and goes
 * through `wt done`, which refuses a branch whose work has not landed in origin's
 * default branch or a merged PR. A forced removal skips both checks and deletes the
 * branch even if unmerged. Refusals come back as results rather than errors.
 *
 * @param {object} options
 * @param {string} options.worktreePath Worktree to remove.
 * @param {string | null} options.branch Checked-out branch, or null when detached.
 * @param {boolean} options.force Discard local changes and unmerged commits.
 * @param {string} options.root Checkout that runs the removal.
 * @param {ProcessRunner} [options.run]
 * @returns {Promise<RemoveWorktreeResult>}
 */
export async function removeWorktree({
  worktreePath,
  branch,
  force,
  root,
  run = runProcess,
}) {
  const target = branch ?? worktreePath;

  if (force) {
    const result = await run(
      worktreeCommand(),
      [
        "remove",
        "--force",
        "--force-delete",
        "--foreground",
        "--yes",
        "--",
        target,
      ],
      { cwd: root, timeoutMs: REMOVAL_TIMEOUT_MS },
    );
    return result.code === 0
      ? removed(target)
      : failed(result, `wt remove exited with code ${result.code}`);
  }

  const status = await run(
    "git",
    ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"],
    { cwd: root },
  );
  if (status.code !== 0) {
    return failed(status, `git status exited with code ${status.code}`);
  }
  const changes = status.stdout.split("\n").filter((line) => line.trim());
  if (changes.length > 0) {
    return {
      ok: false,
      reason: "local-changes",
      message: `${changes.length} uncommitted ${changes.length === 1 ? "change" : "changes"}`,
      // Porcelain lines start with a two-letter status and a space before the path.
      ...limitDetails(changes.map((line) => line.slice(3))),
    };
  }

  // A detached worktree has no branch to merge, so only the clean check applies.
  const result = branch
    ? await run(
        process.execPath,
        [WORKTREE_DONE_SCRIPT, "--foreground", "--yes", "--", branch],
        { cwd: root, timeoutMs: REMOVAL_TIMEOUT_MS },
      )
    : await run(
        worktreeCommand(),
        ["remove", "--foreground", "--yes", "--", worktreePath],
        { cwd: root, timeoutMs: REMOVAL_TIMEOUT_MS },
      );
  if (result.code === 0) {
    return removed(target);
  }

  const kept = branch ? parseKeptBranch(combinedOutput(result), branch) : null;
  if (kept) {
    return {
      ok: false,
      reason: "unmerged",
      message: kept.reason,
      ...limitDetails(kept.commits),
    };
  }
  return failed(result, `Removal exited with code ${result.code}`);
}
