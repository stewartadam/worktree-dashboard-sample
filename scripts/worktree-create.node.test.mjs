import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorktree,
  parseSwitchOutput,
} from "../worktree-dashboard/worktree-create.mjs";

const ROOT = "/repo";

/**
 * Builds a process runner over a fake repository: `refs` lists the refs `git show-ref`
 * finds, `onOrigin` lists branches a fetch adds as remote-tracking refs, `remoteHead`
 * answers `origin/HEAD`, and `wt` scripts the Worktrunk result. Every call is recorded
 * without its `git -C <root>` prefix.
 */
function fakeRepo({
  refs = [],
  onOrigin = [],
  remoteHead = "origin/develop",
  wt,
}) {
  const calls = [];
  /** Answers one Git or Worktrunk call from the fake repository state. */
  const run = async (command, args) => {
    if (command === "git") {
      const gitArgs = args.slice(2);
      calls.push(["git", ...gitArgs]);
      if (gitArgs[0] === "show-ref") {
        return {
          code: refs.includes(gitArgs.at(-1)) ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      }
      if (gitArgs[0] === "fetch") {
        const branch = gitArgs.at(-1).split(":")[0].replace("refs/heads/", "");
        if (!onOrigin.includes(branch)) {
          return { code: 128, stdout: "", stderr: "couldn't find remote ref" };
        }
        refs.push(`refs/remotes/origin/${branch}`);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (gitArgs[0] === "symbolic-ref") {
        return remoteHead
          ? { code: 0, stdout: `${remoteHead}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected git ${gitArgs.join(" ")}`);
    }
    calls.push(["wt", ...args]);
    return { code: 0, stdout: "", stderr: "", ...wt(args) };
  };
  /** Returns the arguments of the single Worktrunk call. */
  const wtArgs = () => calls.find(([name]) => name === "wt")?.slice(1);
  return { run, calls, wtArgs };
}

/** Builds Worktrunk's JSON summary line for a switch. */
function summary(fields) {
  return `${JSON.stringify(fields)}\n`;
}

/** A name with no local or remote branch becomes a new branch from origin's default branch. */
test("createWorktree creates a new branch from origin/HEAD", async () => {
  const repo = fakeRepo({
    wt: () => ({
      stdout: summary({
        action: "created",
        branch: "feature",
        path: "/wt/feature",
      }),
    }),
  });

  const result = await createWorktree({
    branch: " feature ",
    root: ROOT,
    run: repo.run,
  });

  assert.deepEqual(repo.wtArgs(), [
    "switch",
    "--yes",
    "--no-cd",
    "--format",
    "json",
    "--create",
    "--base",
    "origin/develop",
    "feature",
  ]);
  assert.deepEqual(result, {
    ok: true,
    action: "created",
    message: "Created feature",
    branch: "feature",
    path: "/wt/feature",
    details: [],
  });
});

/** Without origin/HEAD, Worktrunk falls back to its own default base. */
test("createWorktree leaves the base to Worktrunk when origin/HEAD is unset", async () => {
  const repo = fakeRepo({
    remoteHead: null,
    wt: () => ({ stdout: summary({ action: "created", path: "/wt/feature" }) }),
  });

  await createWorktree({ branch: "feature", root: ROOT, run: repo.run });

  assert.deepEqual(repo.wtArgs().slice(-2), ["--create", "feature"]);
});

/** A branch only on origin is checked out (tracking it) instead of forked from the base. */
test("createWorktree checks out an existing remote branch without --create", async () => {
  const repo = fakeRepo({
    refs: ["refs/remotes/origin/fix/thing"],
    wt: () => ({
      stdout: summary({ action: "created", path: "/wt/fix-thing" }),
    }),
  });

  const result = await createWorktree({
    branch: "fix/thing",
    root: ROOT,
    run: repo.run,
  });

  assert.deepEqual(repo.wtArgs(), [
    "switch",
    "--yes",
    "--no-cd",
    "--format",
    "json",
    "fix/thing",
  ]);
  assert.equal(result.action, "created");
});

/** A branch pushed to origin since the last fetch is fetched and checked out, not forked. */
test("createWorktree fetches a branch missing locally before deciding to create it", async () => {
  const repo = fakeRepo({
    onOrigin: ["claude/cloud-fix"],
    wt: () => ({
      stdout: summary({ action: "created", path: "/wt/cloud-fix" }),
    }),
  });

  await createWorktree({
    branch: "claude/cloud-fix",
    root: ROOT,
    run: repo.run,
  });

  assert.deepEqual(
    repo.calls.find(([, sub]) => sub === "fetch"),
    [
      "git",
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      "refs/heads/claude/cloud-fix:refs/remotes/origin/claude/cloud-fix",
    ],
  );
  assert.equal(repo.wtArgs().includes("--create"), false);
});

/** A local branch is used as is, without asking origin. */
test("createWorktree skips the fetch for a local branch", async () => {
  const repo = fakeRepo({
    refs: ["refs/heads/feature"],
    wt: () => ({ stdout: summary({ action: "created", path: "/wt/feature" }) }),
  });

  await createWorktree({ branch: "feature", root: ROOT, run: repo.run });

  assert.equal(
    repo.calls.some(([, sub]) => sub === "fetch"),
    false,
  );
  assert.equal(repo.wtArgs().includes("--create"), false);
});

/** A Worktrunk that can't be started (not on PATH) is a refusal, not a thrown error. */
test("createWorktree reports a Worktrunk spawn failure as a result", async () => {
  const repo = fakeRepo({
    wt: () => {
      throw new Error("spawn wt ENOENT");
    },
  });

  const result = await createWorktree({
    branch: "feature",
    root: ROOT,
    run: repo.run,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "spawn wt ENOENT");
});

/** A branch that already has a worktree resolves to it rather than failing. */
test("createWorktree reports a branch that already has a worktree", async () => {
  const repo = fakeRepo({
    refs: ["refs/heads/feature"],
    wt: () => ({
      stdout: summary({
        action: "existing",
        branch: "feature",
        path: "/wt/feature",
      }),
    }),
  });

  const result = await createWorktree({
    branch: "feature",
    root: ROOT,
    run: repo.run,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "existing");
  assert.equal(result.message, "feature already has a worktree");
});

/** Empty names and names Worktrunk would read as options never reach Worktrunk. */
test("createWorktree refuses empty and option-like names", async () => {
  for (const [branch, message] of [
    ["   ", "Enter a branch name"],
    ["--help", "Invalid branch name --help"],
  ]) {
    const repo = fakeRepo({ wt: () => ({ code: 99 }) });
    const result = await createWorktree({ branch, root: ROOT, run: repo.run });
    assert.deepEqual(result, {
      ok: false,
      reason: "invalid",
      message,
      details: [],
    });
    assert.deepEqual(repo.calls, []);
  }
});

/** A Worktrunk refusal surfaces its error line as the message. */
test("createWorktree reports Worktrunk's error line on failure", async () => {
  const repo = fakeRepo({
    wt: () => ({
      code: 1,
      stderr:
        "◎ Running pre-start project:install\n✗ Invalid branch name bad..name\n",
    }),
  });

  const result = await createWorktree({
    branch: "bad..name",
    root: ROOT,
    run: repo.run,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "Invalid branch name bad..name");
  assert.deepEqual(result.details, [
    "◎ Running pre-start project:install",
    "✗ Invalid branch name bad..name",
  ]);
});

/** The JSON summary is found after any other stdout lines, and garbage yields null. */
test("parseSwitchOutput reads the last JSON line", () => {
  assert.deepEqual(parseSwitchOutput('hook output\n{"path":"/wt/a"}\n'), {
    path: "/wt/a",
  });
  assert.equal(parseSwitchOutput("no json here\n"), null);
  assert.equal(parseSwitchOutput("{not json\n"), null);
});
