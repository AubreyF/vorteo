#!/usr/bin/env node
// Lists task worktrees and removes only those whose work is already on the
// integration branch. Dirty, unpublished, locked and primary worktrees stay.
// Usage: node scripts/worktree-cleanup.mjs [--target origin/main] [--idle-hours 24]
//          [--apply] [--json]
// Without --apply this is a dry run. Worktrees whose Git index changed within
// the idle window stay, because a live agent may still be using them.
// Worktrees whose directory is missing are kept unless --prune-missing is
// passed: a shared repository also lists worktrees from other environments,
// such as the Dev container, which this machine cannot see.
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { checkArchiveReadiness } from "./archive-readiness.mjs";
import {
  git,
  hasCommit,
  listWorktrees,
  parseArgs,
  repositoryRoot,
  unpublishedCommits,
} from "./lib/delivery-git.mjs";
import { isMainModule } from "./is-main-module.mjs";

const PROTECTED_BRANCHES = new Set(["main", "next", "installation-integration"]);

function lastActivity(worktreePath) {
  const gitDir = path.resolve(worktreePath, git(worktreePath, ["rev-parse", "--git-dir"]));
  const index = path.join(gitDir, "index");
  return existsSync(index) ? statSync(index).mtimeMs : statSync(gitDir).mtimeMs;
}

export function classifyWorktrees({
  cwd,
  target = "origin/main",
  fetch = true,
  idleHours = 24,
  pruneMissing = false,
  now = Date.now(),
}) {
  const repository = repositoryRoot(cwd);
  if (fetch && target.includes("/")) {
    git(repository, ["fetch", "--quiet", target.split("/")[0]], { allowFailure: true });
  }
  if (!hasCommit(repository, target)) throw new Error(`${target} is unavailable`);
  // The first entry is the primary checkout, which cleanup never touches.
  const [, ...linked] = listWorktrees(repository);
  const current = path.resolve(repository);
  const decide = (worktree) => {
    if (path.resolve(worktree.path) === current) return ["keep", "Current worktree"];
    if (worktree.locked) return ["keep", "Locked"];
    if (worktree.prunable || !existsSync(worktree.path)) {
      return pruneMissing
        ? ["prune", "Directory is missing"]
        : ["keep", "Directory is not visible here; it may belong to another environment"];
    }
    if (worktree.branch && PROTECTED_BRANCHES.has(worktree.branch)) {
      return ["keep", `Protected branch ${worktree.branch}`];
    }
    const idleFor = (now - lastActivity(worktree.path)) / 3_600_000;
    if (idleFor < idleHours) return ["keep", `Active within ${idleHours} hours`];
    const readiness = checkArchiveReadiness({ cwd: worktree.path, target, fetch: false });
    return readiness.ready
      ? ["remove", `Work is on ${target}`]
      : ["keep", readiness.blockers.join("; ")];
  };
  return linked.map((worktree) => {
    const [action, reason] = decide(worktree);
    return { path: worktree.path, branch: worktree.branch, action, reason };
  });
}

export function applyCleanup({ cwd, target, entries }) {
  const repository = repositoryRoot(cwd);
  const results = [];
  for (const entry of entries) {
    if (entry.action !== "remove") continue;
    // No --force: Git itself refuses to remove a worktree with changes.
    git(repository, ["worktree", "remove", entry.path]);
    let branchDeleted = false;
    if (
      entry.branch &&
      !PROTECTED_BRANCHES.has(entry.branch) &&
      unpublishedCommits(repository, target, `refs/heads/${entry.branch}`).length === 0
    ) {
      git(repository, ["branch", "-D", entry.branch]);
      branchDeleted = true;
    }
    results.push({ ...entry, removed: true, branchDeleted });
  }
  if (entries.some((entry) => entry.action === "prune")) git(repository, ["worktree", "prune"]);
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["apply", "json", "prune-missing"],
    options: ["target", "idle-hours"],
  });
  const target = args.target ?? "origin/main";
  const idleHours = args["idle-hours"] === undefined ? 24 : Number(args["idle-hours"]);
  if (!Number.isFinite(idleHours) || idleHours < 0)
    throw new Error("--idle-hours must be a number");
  const entries = classifyWorktrees({
    cwd: process.cwd(),
    target,
    idleHours,
    pruneMissing: Boolean(args["prune-missing"]),
  });
  if (args.apply) applyCleanup({ cwd: process.cwd(), target, entries });
  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  const verb = args.apply
    ? { remove: "Removed", prune: "Pruned" }
    : { remove: "Would remove", prune: "Would prune" };
  for (const entry of entries) {
    const label = verb[entry.action] ?? "Keep";
    console.log(
      `${label}: ${entry.path}${entry.branch ? ` (${entry.branch})` : ""}: ${entry.reason}`,
    );
  }
  if (!args.apply)
    console.log("Dry run. Pass --apply to remove worktrees whose work is published.");
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
