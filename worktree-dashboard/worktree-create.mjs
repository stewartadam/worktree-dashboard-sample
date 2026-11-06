import { runProcess } from "./worktree-remove.mjs";

// Bounds the fetch that looks for a remote branch, so an unreachable origin only delays creation.
const FETCH_TIMEOUT_MS = 30_000;

/**
 * @typedef {import("./worktree-remove.mjs").ProcessRunner} ProcessRunner
 */

/**
 * @typedef {object} CreateWorktreeResult
 * @property {boolean} ok
 * @property {"created" | "existing" | undefined} action On success, whether a worktree
 *   was added or the branch already had one.
 * @property {"invalid" | "failed" | undefined} reason Why creation was refused.
 * @property {string} message One-line summary suited to a toast.
 * @property {string | undefined} branch Branch checked out in the worktree.
 * @property {string | undefined} path Worktree directory.
 * @property {string[]} details Output lines behind a failure.
 */

/** Returns the platform-specific Worktrunk executable name. */
function worktreeCommand() {
  return process.platform === "win32" ? "wt.exe" : "wt";
}

/** Runs Git in the given checkout and reports whether it exited successfully. */
async function gitSucceeds(run, root, args) {
  return (await run("git", ["-C", root, ...args], { cwd: root })).code === 0;
}

/**
 * Resolves origin's default branch (such as `origin/develop`) as the base for new
 * branches, or null when `origin/HEAD` is unset so Worktrunk uses its own default.
 */
async function remoteDefaultBranch(run, root) {
  const result = await run(
    "git",
    [
      "-C",
      root,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ],
    { cwd: root },
  );
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/**
 * Reports whether the branch exists locally or on origin. Worktrunk checks out either
 * without `--create` (tracking origin's copy), while `--create` would refuse a local
 * branch and fork a remote one from the base instead. A branch missing locally is
 * fetched from origin first, so one pushed since the last fetch is found too; a failed
 * fetch (no such branch, or origin unreachable) just leaves the name as new.
 */
async function branchExists(run, root, branch) {
  const exists = (ref) =>
    gitSucceeds(run, root, ["show-ref", "--verify", "--quiet", ref]);
  if (await exists(`refs/heads/${branch}`)) return true;
  await run(
    "git",
    [
      "-C",
      root,
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    { cwd: root, timeoutMs: FETCH_TIMEOUT_MS },
  );
  return exists(`refs/remotes/origin/${branch}`);
}

/**
 * Reads the summary Worktrunk prints with `--format json`, which is the last JSON
 * object on stdout, or null when there is none.
 */
export function parseSwitchOutput(stdout) {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Builds the result for a Worktrunk run that failed, led by its last error line. */
function failed(result) {
  const lines = [result.stdout, result.stderr]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = lines.findLast((line) => line.startsWith("✗"));
  return {
    ok: false,
    reason: "failed",
    message:
      errorLine?.replace(/^✗\s*/u, "") ??
      lines.at(-1) ??
      `wt switch exited with code ${result.code}`,
    details: lines,
  };
}

/**
 * Creates a worktree for a branch through `wt switch`, so Worktrunk's project hooks
 * (`.env` and dependencies, then builds in the background)
 * run exactly as they do for a worktree made in a terminal. Worktrunk picks the path
 * from its template.
 *
 * A branch that exists locally or on origin is checked out; any other name becomes
 * a new branch from origin's default branch. A branch that already has a worktree
 * resolves to that worktree with action "existing". Worktrunk validates the name,
 * and its refusals come back as results rather than errors.
 *
 * @param {object} options
 * @param {string} options.branch Branch to check out or create.
 * @param {string} options.root Checkout that runs Worktrunk.
 * @param {ProcessRunner} [options.run]
 * @returns {Promise<CreateWorktreeResult>}
 */
export async function createWorktree({ branch, root, run = runProcess }) {
  const name = branch.trim();
  // Worktrunk reads a leading dash as an option, and `--` would start --execute arguments.
  if (!name || name.startsWith("-")) {
    return {
      ok: false,
      reason: "invalid",
      message: name ? `Invalid branch name ${name}` : "Enter a branch name",
      details: [],
    };
  }

  const args = ["switch", "--yes", "--no-cd", "--format", "json"];
  if (!(await branchExists(run, root, name))) {
    args.push("--create");
    const base = await remoteDefaultBranch(run, root);
    if (base) args.push("--base", base);
  }
  args.push(name);

  let result;
  try {
    // No timeout: stopping `wt` mid-hook would orphan `npm install` and leave the
    // worktree half set up.
    result = await run(worktreeCommand(), args, { cwd: root });
  } catch (error) {
    return failed({
      code: 1,
      stdout: "",
      stderr: String(error?.message ?? error),
    });
  }
  const summary = result.code === 0 ? parseSwitchOutput(result.stdout) : null;
  if (!summary?.path) return failed(result);

  const existing = summary.action === "existing";
  return {
    ok: true,
    action: existing ? "existing" : "created",
    message: existing
      ? `${summary.branch ?? name} already has a worktree`
      : `Created ${summary.branch ?? name}`,
    branch: summary.branch ?? name,
    path: summary.path,
    details: [],
  };
}
