import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  parseKeptBranch,
  removeWorktree,
} from "../worktree-dashboard/worktree-remove.mjs";

const execFileAsync = promisify(execFile);

/**
 * Builds a process runner that records each call and answers from `respond`,
 * which receives the command name (without a path) and its arguments.
 */
function fakeRunner(respond) {
  const calls = [];
  /** Records a call and returns the scripted result for it. */
  const run = async (command, args) => {
    const name = command === process.execPath ? "node" : command;
    calls.push([name, ...args]);
    return { code: 0, stdout: "", stderr: "", ...respond(name, args) };
  };
  return { run, calls };
}

const WORKTREE = "/repo-worktrees/feature";
const ROOT = "/repo";

/** Without force, a dirty worktree is refused before any removal command runs. */
test("removeWorktree refuses a worktree with local changes", async () => {
  const { run, calls } = fakeRunner((command) =>
    command === "git"
      ? { stdout: " M webui/app.tsx\n?? notes.md\n" }
      : { code: 99 },
  );

  const result = await removeWorktree({
    worktreePath: WORKTREE,
    branch: "feature",
    force: false,
    root: ROOT,
    run,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "local-changes",
    message: "2 uncommitted changes",
    details: ["webui/app.tsx", "notes.md"],
    total: 2,
  });
  assert.equal(calls.length, 1);
});

/** Long change lists are capped, with a trailing line counting what was left out. */
test("removeWorktree caps the reported changes", async () => {
  const lines = Array.from({ length: 13 }, (_, i) => `?? file-${i}.txt`);
  const { run } = fakeRunner(() => ({ stdout: `${lines.join("\n")}\n` }));

  const result = await removeWorktree({
    worktreePath: WORKTREE,
    branch: "feature",
    force: false,
    root: ROOT,
    run,
  });

  assert.equal(result.details.length, 11);
  assert.equal(result.details.at(-1), "…and 3 more");
  assert.equal(result.total, 13);
});

/** A clean worktree goes through `wt done`, whose kept-branch report becomes an unmerged refusal. */
test("removeWorktree reports an unmerged branch kept by wt done", async () => {
  const { run, calls } = fakeRunner((command) =>
    command === "node"
      ? {
          code: 1,
          stderr: [
            "Kept feature: no merged PR found (no pull requests found)",
            "  Unmerged commits:",
            "    abc1234 feat: one",
            "    def5678 feat: two",
            "",
          ].join("\n"),
        }
      : {},
  );

  const result = await removeWorktree({
    worktreePath: WORKTREE,
    branch: "feature",
    force: false,
    root: ROOT,
    run,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "unmerged",
    message: "no merged PR found (no pull requests found)",
    details: ["abc1234 feat: one", "def5678 feat: two"],
    total: 2,
  });
  assert.deepEqual(calls[1], [
    "node",
    fileURLToPath(new URL("./worktree-done.mjs", import.meta.url)),
    "--foreground",
    "--yes",
    "--",
    "feature",
  ]);
});

/** A landed, clean branch is removed and reported as a success. */
test("removeWorktree succeeds when wt done removes the worktree", async () => {
  const { run } = fakeRunner(() => ({}));

  const result = await removeWorktree({
    worktreePath: WORKTREE,
    branch: "feature",
    force: false,
    root: ROOT,
    run,
  });

  assert.equal(result.ok, true);
});

/** Detached worktrees have no branch to check, so plain `wt remove` runs on the path. */
test("removeWorktree removes a clean detached worktree by path", async () => {
  const { run, calls } = fakeRunner(() => ({}));

  const result = await removeWorktree({
    worktreePath: WORKTREE,
    branch: null,
    force: false,
    root: ROOT,
    run,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[1], [
    "wt",
    "remove",
    "--foreground",
    "--yes",
    "--",
    WORKTREE,
  ]);
});

/** Forcing skips the checks and asks Worktrunk to discard changes and unmerged branches. */
test("removeWorktree force removes without checks", async () => {
  const { run, calls } = fakeRunner(() => ({}));

  const result = await removeWorktree({
    worktreePath: WORKTREE,
    branch: "feature",
    force: true,
    root: ROOT,
    run,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    [
      "wt",
      "remove",
      "--force",
      "--force-delete",
      "--foreground",
      "--yes",
      "--",
      "feature",
    ],
  ]);
});

/** Failures that are neither refusal surface the command's last output line. */
test("removeWorktree reports other failures", async () => {
  const { run } = fakeRunner(() => ({
    code: 1,
    stderr: "✗ Cannot remove: worktree is locked\n",
  }));

  const result = await removeWorktree({
    worktreePath: WORKTREE,
    branch: "feature",
    force: true,
    root: ROOT,
    run,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "✗ Cannot remove: worktree is locked");
});

/** Only the named branch's report is parsed, ignoring other kept branches. */
test("parseKeptBranch ignores reports for other branches", () => {
  const output = "Kept other: no merged PR found\n";
  assert.equal(parseKeptBranch(output, "feature"), null);
});

/**
 * Removes the `GIT_*` variables a Git hook exports, such as `GIT_DIR`, until the test ends, so
 * fixture commands touch only the temporary repository and never the repository being pushed.
 */
function isolateFromHookGitEnvironment(t) {
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")),
  );
  for (const key of Object.keys(gitEnvironment)) delete process.env[key];
  t.after(() => Object.assign(process.env, gitEnvironment));
}

/** The local-changes check sees untracked files in a real git worktree. */
test("removeWorktree detects untracked files with real git", async (t) => {
  isolateFromHookGitEnvironment(t);
  const repo = await mkdtemp(join(tmpdir(), "worktree-worktree-remove-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet", repo]);
  await writeFile(join(repo, "scratch.txt"), "draft\n");

  const result = await removeWorktree({
    worktreePath: repo,
    branch: "feature",
    force: false,
    root: repo,
  });

  assert.equal(result.reason, "local-changes");
  assert.deepEqual(result.details, ["scratch.txt"]);
});
