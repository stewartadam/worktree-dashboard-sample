import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createWorktree } from "../worktree-dashboard/worktree-create.mjs";

/**
 * The checkout Claude Code started from. Hook input carries it as `cwd`; Claude Code
 * also exports CLAUDE_PROJECT_DIR, which wins when a session runs from a subdirectory.
 */
function repoDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd;
}

/**
 * Runs a command for `createWorktree` without a terminal so approval prompts cannot
 * block Claude Code. Worktrunk's progress and project hook output stream to stderr,
 * which Claude Code shows on failure; stdout is captured for the JSON summary.
 *
 * @type {import("../worktree-dashboard/worktree-remove.mjs").ProcessRunner}
 */
function runWithLiveStderr(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr: "" }),
    );
  });
}

/**
 * Runs Worktrunk without a terminal so approval prompts cannot block Claude Code.
 * Worktrunk's progress and project hook output go to stderr, which Claude Code shows
 * on failure; stdout is captured because Claude Code reads it as the hook result.
 */
function wt(args) {
  const result = spawnSync("wt", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wt ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout;
}

/**
 * Creates the worktree Claude Code asked for through the dashboard's shared
 * `createWorktree`, so Worktrunk's project hooks (`.env` and dependencies, then builds)
 * run exactly as they do for a manually created worktree. Worktrunk picks the path
 * from its own template, so the path Claude Code proposed is ignored and the real one
 * is printed for Claude Code. New branches start from origin's default branch,
 * matching Claude Code's own default, and an existing branch is checked out again.
 * Claude Code only supplies a worktree slug (`name`), so the branch is `claude/<name>`.
 */
async function create(input) {
  const result = await createWorktree({
    branch: `claude/${input.name}`,
    root: repoDir(input),
    run: runWithLiveStderr,
  });
  if (!result.ok) throw new Error(result.message);
  process.stdout.write(`${result.path}\n`);
}

/**
 * Removes a Claude Code worktree through `wt remove` so the pre-remove hook stops its
 * services. Worktrunk refuses dirty worktrees and keeps unmerged branches, so session
 * cleanup never discards work; Claude Code then reports the worktree as kept.
 */
function remove(input) {
  const worktreePath = input.worktree_path;
  wt(["-C", repoDir(input), "remove", "--yes", "--foreground", worktreePath]);
}

/** Dispatches a Claude Code WorktreeCreate or WorktreeRemove hook payload from stdin. */
async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (!repoDir(input)) throw new Error("hook input has no cwd");
  switch (input.hook_event_name) {
    case "WorktreeCreate":
      if (!input.name) throw new Error("WorktreeCreate input has no name");
      await create(input);
      break;
    case "WorktreeRemove":
      remove(input);
      break;
    default:
      throw new Error(`unsupported hook event ${input.hook_event_name}`);
  }
}

main().catch((error) => {
  process.stderr.write(`claude-worktree-hook: ${error.message}\n`);
  process.exit(1);
});
