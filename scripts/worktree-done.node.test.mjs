import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./worktree-done.mjs", import.meta.url));
const hasWorktrunk = spawnSync("wt", ["--version"]).status === 0;

/** Builds an isolated origin, stale clone, linked worktree, and deterministic GitHub CLI. */
function fixture(t, target = "develop") {
  const root = mkdtempSync(join(tmpdir(), "worktree-wt-done-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream");
  const repo = join(root, "repo");
  const worktree = join(root, "feature worktree");
  const bin = join(root, "bin");
  mkdirSync(upstream);
  mkdirSync(bin);
  writeFileSync(join(root, "wt.toml"), "");
  // Git hooks export repository selectors; inheriting them would redirect test Git commands.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") && !key.startsWith("WORKTRUNK_"),
    ),
  );
  const env = {
    ...inherited,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    WORKTRUNK_CONFIG_PATH: join(root, "wt.toml"),
    WORKTRUNK_SYSTEM_CONFIG_PATH: join(root, "wt.toml"),
    WORKTRUNK_PROJECT_CONFIG_PATH: join(root, "wt.toml"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GH_TEST_TARGET: target,
    GH_TEST_STATE: "MERGED",
  };
  /** Runs real Git in a selected repository using the isolated test configuration. */
  function git(cwd, ...args) {
    return execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  git(upstream, "init", "-b", "main");
  git(upstream, "config", "user.name", "Test");
  git(upstream, "config", "user.email", "test@example.test");
  git(upstream, "commit", "--allow-empty", "-m", "initial");
  if (target !== "main") git(upstream, "switch", "-c", target);
  git(root, "clone", upstream, repo);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "worktrunk.default-branch", "main");
  git(repo, "worktree", "add", "-b", "feature", worktree);
  writeFileSync(join(worktree, "feature.txt"), "merged feature\n");
  git(worktree, "add", "feature.txt");
  git(worktree, "commit", "-m", "feature");
  // Origin learns the feature only after the clone's tracking ref was created.
  git(upstream, "fetch", repo, "feature");
  git(upstream, "merge", "--squash", "FETCH_HEAD");
  git(upstream, "commit", "-m", "squash feature");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
if (process.env.GH_TEST_FAIL) { process.stderr.write('GitHub unavailable'); process.exit(1); }
const args = process.argv.slice(2);
if (args[0] !== 'pr' || args[1] !== 'view' || args[3] !== '--repo') process.exit(2);
process.stdout.write(JSON.stringify({ state: process.env.GH_TEST_STATE, baseRefName: args[2] === 'other' ? 'main' : process.env.GH_TEST_TARGET, headRefName: args[2], isCrossRepository: !!process.env.GH_TEST_FORK, url: 'https://github.com/test/repo/pull/1' }));
`,
    { mode: 0o755 },
  );
  /** Executes the cleanup script, defaulting to synchronous cleanup of the named branch. */
  function done(args = ["feature", "--foreground", "--no-hooks"], cwd = repo) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  }
  /** Checks both the feature reference and worktree survive a rejected cleanup. */
  function assertRetained(result) {
    assert.notEqual(result.status, 0, result.stderr);
    assert.ok(existsSync(worktree));
    git(repo, "show-ref", "--verify", "refs/heads/feature");
  }
  /** Commits work on the feature branch that no target contains, so only a PR can vouch for it. */
  function addUnmergedWork() {
    writeFileSync(join(worktree, "unmerged.txt"), "unmerged work\n");
    git(worktree, "add", "unmerged.txt");
    git(worktree, "commit", "-m", "unmerged work");
  }
  return {
    root,
    upstream,
    repo,
    worktree,
    env,
    git,
    done,
    assertRetained,
    addUnmergedWork,
  };
}

for (const target of ["main", "develop"]) {
  /** Exercises real squash-merge detection against freshly fetched PR targets. */
  test(`removes a squash-merged branch targeting ${target}`, {
    skip: !hasWorktrunk,
  }, (t) => {
    const f = fixture(t, target);
    const result = f.done();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.worktree), false);
    assert.throws(() =>
      f.git(f.repo, "show-ref", "--verify", "refs/heads/feature"),
    );
    assert.equal(f.git(f.repo, "config", "worktrunk.default-branch"), "main");
    assert.equal(
      f.git(f.repo, "rev-parse", `origin/${target}`),
      f.git(f.upstream, "rev-parse", "HEAD"),
    );
  });
}

/** Ensures a merged PR does not authorize deleting commits added locally afterwards. */
test("retains a branch with additional unmerged local work", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  writeFileSync(join(f.worktree, "later.txt"), "keep this work\n");
  f.git(f.worktree, "add", "later.txt");
  f.git(f.worktree, "commit", "-m", "later work");
  const result = f.done();
  assert.equal(result.status, 0, result.stderr);
  f.git(f.repo, "show-ref", "--verify", "refs/heads/feature");
  assert.match(
    result.stderr,
    /[Uu]nmerged|[Nn]ot merged|[Nn]ot integrated|[Kk]ept|[Rr]etain/,
  );
});

/** Verifies Worktrunk still rejects a dirty worktree instead of discarding edits. */
test("refuses dirty worktrees", { skip: !hasWorktrunk }, (t) => {
  const f = fixture(t);
  writeFileSync(join(f.worktree, "feature.txt"), "uncommitted edit\n");
  f.assertRetained(f.done());
});

/** Exercises current-worktree resolution and propagates the shell's directory directive. */
test("defaults to the current branch and preserves shell integration", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  f.env.WORKTRUNK_DIRECTIVE_CD_FILE = join(f.root, "cd-directive");
  const result = f.done(["--foreground", "--no-hooks"], f.worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  assert.ok(existsSync(f.env.WORKTRUNK_DIRECTIVE_CD_FILE));
});

/** Honors explicit branch retention while still removing the merged worktree. */
test("forwards --no-delete-branch", { skip: !hasWorktrunk }, (t) => {
  const f = fixture(t);
  const result = f.done([
    "feature",
    "--foreground",
    "--no-hooks",
    "--no-delete-branch",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  f.git(f.repo, "show-ref", "--verify", "refs/heads/feature");
});

for (const state of ["OPEN", "CLOSED"]) {
  /** Keeps unmerged work whose PR has not been merged and lists the commits that would be lost. */
  test(`keeps unmerged work with ${state.toLowerCase()} PRs`, (t) => {
    const f = fixture(t);
    f.addUnmergedWork();
    f.env.GH_TEST_STATE = state;
    const result = f.done();
    f.assertRetained(result);
    assert.match(result.stderr, /Kept feature/);
    assert.match(result.stderr, /unmerged work/);
  });
}

/** Keeps unmerged work when GitHub cannot vouch for it, reporting the commits instead. */
test("keeps unmerged work after a GitHub lookup failure", (t) => {
  const f = fixture(t);
  f.addUnmergedWork();
  f.env.GH_TEST_FAIL = "1";
  const result = f.done();
  f.assertRetained(result);
  assert.match(result.stderr, /unmerged work/);
});

/** Landed commits need no PR, so GitHub being unavailable does not block cleanup. */
test("removes a branch already in the default branch without GitHub", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  f.env.GH_TEST_FAIL = "1";
  const result = f.done();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  assert.throws(() =>
    f.git(f.repo, "show-ref", "--verify", "refs/heads/feature"),
  );
});

/** Offline cleanup compares against the last fetched default branch instead of failing. */
test("removes a landed branch while origin is unreachable", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  f.git(f.repo, "fetch", "origin");
  f.git(f.repo, "remote", "set-url", "origin", join(f.root, "missing"));
  f.env.GH_TEST_FAIL = "1";
  const result = f.done();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  assert.match(result.stderr, /last fetched/);
});

/** Avoids using a different repository's identically named PR branch as evidence. */
test("keeps unmerged work with fork PRs", (t) => {
  const f = fixture(t);
  f.addUnmergedWork();
  f.env.GH_TEST_FORK = "1";
  f.assertRetained(f.done());
});

/** A missing target must not trigger cleanup against stale tracking references. */
test("keeps unmerged work when fetching the PR target fails", (t) => {
  const f = fixture(t);
  f.addUnmergedWork();
  f.env.GH_TEST_TARGET = "deleted-target";
  f.assertRetained(f.done());
});

/** One unmerged branch is reported without stopping cleanup of the branches that landed. */
test("cleans landed branches and reports the unmerged ones", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  const other = join(f.root, "other-worktree");
  f.git(f.repo, "worktree", "add", "-b", "other", other, "origin/main");
  writeFileSync(join(other, "other.txt"), "never merged\n");
  f.git(other, "add", "other.txt");
  f.git(other, "commit", "-m", "never merged");
  f.env.GH_TEST_FAIL = "1";
  const result = f.done(["feature", "other", "--foreground", "--no-hooks"]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.worktree), false);
  assert.ok(existsSync(other));
  assert.match(result.stderr, /Kept other/);
  assert.match(result.stderr, /never merged/);
});

/** Rejects force flags so a typo cannot bypass the alias's normal cleanup checks. */
test("does not accept forced deletion", (t) => {
  const f = fixture(t);
  f.assertRetained(f.done(["feature", "-D"]));
});

/** Validates every requested branch before starting a potentially partial cleanup. */
test("a missing later branch prevents any removal", (t) => {
  const f = fixture(t);
  f.assertRetained(
    f.done(["feature", "missing-branch", "--foreground", "--no-hooks"]),
  );
});

/** Uses each PR's own target and removes the invoking worktree last, even if listed first. */
test("cleans multiple branches with mixed targets from the current worktree", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  const other = join(f.root, "other-worktree");
  f.git(f.repo, "worktree", "add", "-b", "other", other, "origin/main");
  writeFileSync(join(other, "other.txt"), "other change\n");
  f.git(other, "add", "other.txt");
  f.git(other, "commit", "-m", "other feature");
  f.git(f.upstream, "switch", "main");
  f.git(f.upstream, "fetch", f.repo, "other");
  f.git(f.upstream, "merge", "--squash", "FETCH_HEAD");
  f.git(f.upstream, "commit", "-m", "squash other");
  const result = f.done(
    ["feature", "other", "feature", "--foreground", "--no-hooks"],
    f.worktree,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(existsSync(other), false);
  for (const branch of ["feature", "other"]) {
    assert.throws(() =>
      f.git(f.repo, "show-ref", "--verify", `refs/heads/${branch}`),
    );
  }
  assert.equal(f.git(f.repo, "config", "worktrunk.default-branch"), "main");
});
