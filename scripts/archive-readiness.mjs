#!/usr/bin/env node
// Proves a task's work survives archiving: nothing uncommitted, every commit on
// the integration branch, and optionally contained in an installed release.
// Usage: node scripts/archive-readiness.mjs [worktree] [--target origin/main]
//          [--installed <commit>] [--no-fetch] [--json]
// Exit status 0 means ready; 1 means blocked; 2 means the check itself failed.
import path from "node:path";
import {
  git,
  hasCommit,
  isAncestor,
  parseArgs,
  repositoryRoot,
  unpublishedCommits,
  workingTreeChanges,
} from "./lib/delivery-git.mjs";
import { isMainModule } from "./is-main-module.mjs";

export function checkArchiveReadiness({
  cwd,
  target = "origin/main",
  installed = null,
  fetch = true,
}) {
  const root = repositoryRoot(cwd);
  const blockers = [];
  if (fetch) {
    const remote = target.includes("/") ? target.split("/")[0] : null;
    if (remote) git(root, ["fetch", "--quiet", remote], { allowFailure: true });
  }
  if (!hasCommit(root, target)) {
    return { root, ready: false, blockers: [`Integration branch ${target} is unavailable`] };
  }
  const changes = workingTreeChanges(root);
  if (changes.tracked.length) {
    blockers.push(`Uncommitted changes: ${changes.tracked.join(", ")}`);
  }
  if (changes.untracked.length) {
    blockers.push(`Untracked files: ${changes.untracked.join(", ")}`);
  }
  const pending = unpublishedCommits(root, target);
  if (pending.length) {
    blockers.push(
      `Commits not on ${target}: ${pending.map((commit) => `${commit.sha.slice(0, 9)} ${commit.subject}`).join("; ")}`,
    );
  }
  if (installed) {
    if (!hasCommit(root, installed)) {
      blockers.push(`Installed release ${installed} is not available locally; fetch it first`);
    } else if (pending.length === 0 && unpublishedCommits(root, installed).length) {
      blockers.push(`The installed release ${installed.slice(0, 9)} does not contain this work`);
    }
  }
  return {
    root,
    head: git(root, ["rev-parse", "HEAD"]),
    target,
    contained: pending.length === 0 && isAncestor(root, "HEAD", target),
    ready: blockers.length === 0,
    blockers,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["json", "no-fetch"],
    options: ["target", "installed"],
  });
  const result = checkArchiveReadiness({
    cwd: path.resolve(args._[0] ?? "."),
    target: args.target ?? "origin/main",
    installed: args.installed ?? null,
    fetch: !args["no-fetch"],
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ready) {
    console.log(`Ready to archive: ${result.root} is committed and on ${result.target}.`);
  } else {
    console.log(`Not ready to archive: ${result.root}`);
    for (const blocker of result.blockers) console.log(`- ${blocker}`);
  }
  process.exitCode = result.ready ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
