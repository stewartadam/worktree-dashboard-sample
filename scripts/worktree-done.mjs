import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

/** Runs a read or fetch without shell interpolation and preserves failure details. */
function output(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Overrides Worktrunk's comparison target for this process tree only. */
function targetEnvironment(target) {
  const env = { ...process.env };
  const index = Number(env.GIT_CONFIG_COUNT ?? 0);
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = "worktrunk.default-branch";
  env[`GIT_CONFIG_VALUE_${index}`] = target;
  return env;
}

/** Fetches one origin branch into its tracking ref so comparisons see the latest target. */
function fetchTarget(target) {
  output("git", [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${target}:refs/remotes/origin/${target}`,
  ]);
}

/**
 * Lists the branch's commits whose changes are not in the target, one oneline entry each.
 * Patch-equivalent commits (rebased or cherry-picked onto the target) count as landed.
 */
function unmergedCommits(targetRef, branch) {
  const log = output("git", [
    "log",
    "--oneline",
    "--no-decorate",
    "--cherry-pick",
    "--right-only",
    `${targetRef}...refs/heads/${branch}`,
  ]);
  return log ? log.split("\n") : [];
}

/**
 * Resolves origin's default branch and refreshes it. Offline, the last fetched tracking
 * ref is used so branches that already landed can still be cleaned up.
 */
function defaultTarget() {
  const head = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { encoding: "utf8" },
  ).stdout?.trim();
  if (!head?.startsWith("origin/")) return null;
  const target = head.slice("origin/".length);
  try {
    fetchTarget(target);
  } catch (error) {
    process.stderr.write(
      `Could not fetch origin/${target}; using the last fetched copy (${firstLine(error)})\n`,
    );
  }
  return target;
}

/** Extracts the most useful single line from a failed command for a short report. */
function firstLine(error) {
  const text = String(error.stderr || error.message).trim();
  return text.split("\n").find((line) => line.trim()) ?? text;
}

/**
 * Decides how one branch can be cleaned up. A branch whose commits are all in origin's
 * default branch is removed without asking GitHub. Otherwise a merged same-repository PR
 * (for example a squash merge) supplies the target to compare against. Anything else is
 * kept and reported with its unmerged commits.
 */
function planBranch(branch, repository, fallbackTarget) {
  if (
    fallbackTarget &&
    unmergedCommits(`origin/${fallbackTarget}`, branch).length === 0
  ) {
    return {
      branch,
      target: fallbackTarget,
      why: `in origin/${fallbackTarget}`,
    };
  }
  /** Builds the report entry for a branch that must not be removed. */
  const keep = (reason) => ({
    branch,
    reason,
    commits: fallbackTarget
      ? unmergedCommits(`origin/${fallbackTarget}`, branch)
      : [],
  });
  let pr;
  try {
    pr = JSON.parse(
      output("gh", [
        "pr",
        "view",
        branch,
        "--repo",
        repository,
        "--json",
        "state,baseRefName,headRefName,isCrossRepository,url",
      ]),
    );
  } catch (error) {
    return keep(`no merged PR found (${firstLine(error)})`);
  }
  if (
    pr.state !== "MERGED" ||
    pr.isCrossRepository ||
    pr.headRefName !== branch
  ) {
    return keep(
      `PR ${pr.url} is ${pr.state.toLowerCase()}, not a merged PR from this repository`,
    );
  }
  try {
    output("git", ["check-ref-format", `refs/heads/${pr.baseRefName}`]);
    fetchTarget(pr.baseRefName);
  } catch (error) {
    return keep(
      `could not fetch PR target ${pr.baseRefName} (${firstLine(error)})`,
    );
  }
  return { branch, target: pr.baseRefName, why: pr.url };
}

/**
 * Removes worktrees whose work has landed, checking origin's default branch first and a
 * merged GitHub PR second, and reports branches with unmerged commits instead of removing
 * them. Worktrunk's own merge and dirty-worktree checks still apply to every removal.
 */
function main() {
  const { values, positionals } = parseArgs({
    options: {
      foreground: { type: "boolean" },
      reap: { type: "boolean" },
      "no-delete-branch": { type: "boolean" },
      "no-hooks": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(
      "Usage: wt done [branch ...] [--foreground] [--reap] [--no-delete-branch] [--no-hooks] [-y]\n" +
        "Removes each branch's worktree once its work has landed. Defaults to the current branch.\n" +
        "Branches whose commits are in origin's default branch are removed without GitHub.\n" +
        "Otherwise a merged same-repository PR (e.g. a squash merge) is required; branches\n" +
        "without one are kept and their unmerged commits reported. Worktrunk's merge and\n" +
        "dirty-worktree checks still apply. For forced cleanup, use wt remove directly.\n",
    );
    return;
  }

  const branches = [
    ...new Set(
      positionals.length
        ? positionals
        : [output("git", ["symbolic-ref", "--quiet", "--short", "HEAD"])],
    ),
  ];
  for (const branch of branches) {
    output("git", ["show-ref", "--verify", `refs/heads/${branch}`]);
  }
  const repository = output("git", ["remote", "get-url", "origin"]);
  const fallbackTarget = defaultTarget();
  // Finish lookups and fetches before removing any requested worktree.
  const decisions = branches.map((branch) =>
    planBranch(branch, repository, fallbackTarget),
  );
  const plans = decisions.filter((decision) => decision.target);
  const kept = decisions.filter((decision) => !decision.target);

  const flags = Object.keys(values)
    .filter((key) => values[key])
    .map((key) => `--${key}`);
  // Remove the invoking worktree last so subsequent commands retain their cwd.
  const current = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { encoding: "utf8" },
  ).stdout?.trim();
  plans.sort(
    (a, b) => Number(a.branch === current) - Number(b.branch === current),
  );
  let status = 0;
  for (const { branch, target, why } of plans) {
    process.stderr.write(
      `Checking ${branch} against origin/${target} (${why})\n`,
    );
    const result = spawnSync("wt", ["remove", ...flags, "--", branch], {
      stdio: "inherit",
      env: targetEnvironment(`origin/${target}`),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) status = result.status ?? 1;
  }
  for (const { branch, reason, commits } of kept) {
    process.stderr.write(`Kept ${branch}: ${reason}\n`);
    if (commits.length) {
      process.stderr.write(
        `  Unmerged commits:\n${commits.map((line) => `    ${line}`).join("\n")}\n`,
      );
    }
    status ||= 1;
  }
  process.exitCode = status;
}

try {
  main();
} catch (error) {
  process.stderr.write(`wt done: ${error.message}\n`);
  process.exitCode = 1;
}
