import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./claude-worktree-hook.mjs", import.meta.url),
);
const hasWorktrunk = spawnSync("wt", ["--version"]).status === 0;

/**
 * Builds a bare origin and clone whose Worktrunk project config writes `.env` in a
 * pre-start hook, and returns helpers that feed Claude Code hook payloads to the script.
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "worktree-claude-worktree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream.git");
  const repo = join(root, "repo");
  const userConfig = join(root, "user.toml");
  const projectConfig = join(root, "project.toml");
  writeFileSync(userConfig, "");
  writeFileSync(
    projectConfig,
    '[[pre-start]]\nsetup-env = "echo WORKTREE_APP_PORT=4000 > .env"\n',
  );
  // Git hooks export repository selectors, and a Claude Code session exports
  // CLAUDE_PROJECT_DIR, which the script prefers over `cwd`; inheriting either would
  // point the test at the invoking checkout instead of the fixture.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_") &&
        !key.startsWith("WORKTRUNK_") &&
        key !== "CLAUDE_PROJECT_DIR",
    ),
  );
  const env = {
    ...inherited,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    WORKTRUNK_CONFIG_PATH: userConfig,
    WORKTRUNK_SYSTEM_CONFIG_PATH: userConfig,
    WORKTRUNK_PROJECT_CONFIG_PATH: projectConfig,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  /** Runs real Git in a selected directory using the isolated test configuration. */
  function git(cwd, ...args) {
    return execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  git(root, "init", "--quiet", "--bare", "--initial-branch=develop", upstream);
  git(root, "clone", "--quiet", upstream, repo);
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "push", "--quiet", "origin", "develop");
  git(repo, "remote", "set-head", "origin", "develop");

  /** Sends one hook payload to the script the way Claude Code does, via stdin. */
  function hook(payload) {
    return spawnSync("node", [script], {
      cwd: repo,
      env,
      encoding: "utf8",
      input: JSON.stringify({ ...payload, cwd: repo }),
    });
  }
  return { repo, git, hook };
}

test("WorktreeCreate creates the branch through wt and prints the initialized path", {
  skip: !hasWorktrunk && "wt is not installed",
}, (t) => {
  const f = fixture(t);
  const result = f.hook({
    hook_event_name: "WorktreeCreate",
    name: "feature",
    worktree_path: join(f.repo, ".claude/worktrees/feature"),
  });
  assert.equal(result.status, 0, result.stderr);
  const path = result.stdout.trim();
  assert.equal(path.split("\n").length, 1);
  assert.equal(
    readFileSync(join(path, ".env"), "utf8").trim(),
    "WORKTREE_APP_PORT=4000",
  );
  assert.equal(f.git(path, "branch", "--show-current"), "claude/feature");
  assert.equal(
    f.git(path, "rev-parse", "HEAD"),
    f.git(f.repo, "rev-parse", "origin/develop"),
  );
});

test("WorktreeCreate reuses an existing branch instead of failing", {
  skip: !hasWorktrunk && "wt is not installed",
}, (t) => {
  const f = fixture(t);
  f.git(f.repo, "branch", "claude/resume");
  const result = f.hook({
    hook_event_name: "WorktreeCreate",
    name: "resume",
    worktree_path: join(f.repo, ".claude/worktrees/resume"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    f.git(result.stdout.trim(), "branch", "--show-current"),
    "claude/resume",
  );
});

test("WorktreeRemove deletes merged worktrees but keeps unmerged commits and dirty files", {
  skip: !hasWorktrunk && "wt is not installed",
}, (t) => {
  const f = fixture(t);
  /**
   * Creates a Claude Code worktree for a slug and returns its path, failing the test
   * first so an empty path can never resolve files against the invoking checkout.
   */
  const create = (name) => {
    const result = f.hook({
      hook_event_name: "WorktreeCreate",
      name,
      worktree_path: "/unused",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const merged = create("merged");
  const unmerged = create("unmerged");
  const dirty = create("dirty");
  writeFileSync(join(unmerged, "work.txt"), "work\n");
  f.git(unmerged, "add", "work.txt");
  f.git(unmerged, "commit", "--quiet", "-m", "work");
  writeFileSync(join(dirty, "scratch.txt"), "scratch\n");

  /** Sends a WorktreeRemove payload for one worktree path. */
  const remove = (path) =>
    f.hook({ hook_event_name: "WorktreeRemove", worktree_path: path });

  assert.equal(remove(merged).status, 0);
  assert.equal(existsSync(merged), false);
  assert.equal(f.git(f.repo, "branch", "--list", "claude/merged"), "");

  assert.equal(remove(unmerged).status, 0);
  assert.equal(existsSync(unmerged), false);
  assert.match(
    f.git(f.repo, "branch", "--list", "claude/unmerged"),
    /unmerged/,
  );

  assert.notEqual(remove(dirty).status, 0);
  assert.equal(existsSync(join(dirty, "scratch.txt")), true);
});
