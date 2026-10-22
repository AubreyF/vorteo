import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Shared Git checks for the agent lifecycle scripts: task worktrees,
// publication, archive readiness, cleanup and Host delivery. Each check reads
// repository state and never mutates it unless the caller asks.

export function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    if (allowFailure) return null;
    const stderr = error?.stderr?.toString().trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, {
      cause: error,
    });
  }
}

export function hasCommit(cwd, ref) {
  return Boolean(
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true }),
  );
}

/** Uncommitted and untracked paths, as `git status --porcelain` reports them. */
export function workingTreeChanges(cwd) {
  const output = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const tracked = [];
  const untracked = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const file = line.slice(3);
    if (line.startsWith("??")) untracked.push(file);
    else tracked.push(file);
  }
  return { tracked, untracked };
}

/**
 * Commits on `head` whose changes are not on `target`. `git cherry` compares
 * patch IDs, so a commit that reached the target by cherry-pick or rebase
 * counts as published. A squashed commit does not match by patch ID, so a
 * branch whose combined diff is already on the target also counts.
 */
export function unpublishedCommits(cwd, target, head = "HEAD") {
  const output = git(cwd, ["cherry", target, head]);
  const pending = output
    .split("\n")
    .filter((line) => line.startsWith("+ "))
    .map((line) => line.slice(2).trim());
  if (pending.length === 0) return [];
  // Squash or merge equivalence: merging the branch into the target changes nothing.
  const merged = git(cwd, ["merge-tree", "--write-tree", target, head], { allowFailure: true });
  const mergedTree = merged?.split("\n")[0];
  const targetTree = git(cwd, ["rev-parse", `${target}^{tree}`]);
  if (mergedTree && mergedTree === targetTree) return [];
  return pending.map((sha) => ({
    sha,
    subject: git(cwd, ["log", "-1", "--format=%s", sha]),
  }));
}

export function isAncestor(cwd, ancestor, descendant) {
  return (
    git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], {
      allowFailure: true,
    }) !== null
  );
}

export function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function repositoryRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Worktrees from `git worktree list --porcelain`. */
export function listWorktrees(cwd) {
  const output = git(cwd, ["worktree", "list", "--porcelain"]);
  const worktrees = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), head: null, branch: null, locked: false, prunable: false };
      worktrees.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch "))
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line.startsWith("locked")) current.locked = true;
    else if (line.startsWith("prunable")) current.prunable = true;
    else if (line === "bare") current.bare = true;
  }
  return worktrees;
}

/**
 * Locates Gitleaks for the pre-push secret scan. Agent shells often lack the
 * user's PATH additions, so common install locations are checked too.
 */
export function findGitleaks(env = process.env) {
  if (env.PASEO_GITLEAKS_BIN) {
    return existsSync(env.PASEO_GITLEAKS_BIN) ? env.PASEO_GITLEAKS_BIN : null;
  }
  const directories = [
    ...(env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), "go", "bin"),
  ];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(
      directory,
      process.platform === "win32" ? "gitleaks.exe" : "gitleaks",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (flags.includes(name)) result[name] = true;
    else if (options.includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      result[name] = value;
      index += 1;
    } else throw new Error(`Unknown option --${name}`);
  }
  return result;
}
