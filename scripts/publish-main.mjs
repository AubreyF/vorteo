#!/usr/bin/env node
// Publishes the current commit to the integration branch with a normal
// fast-forward push, then proves the remote contains it.
// Usage: node scripts/publish-main.mjs [--remote origin] [--branch main] [--dry-run]
// Exit status 0 means published (or ready, for a dry run); 1 means refused.
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  findGitleaks,
  git,
  isAncestor,
  parseArgs,
  repositoryRoot,
  workingTreeChanges,
} from "./lib/delivery-git.mjs";
import { isMainModule } from "./is-main-module.mjs";

export class PublishRefusal extends Error {}

export function preparePublication({ cwd, remote = "origin", branch = "main", env = process.env }) {
  const root = repositoryRoot(cwd);
  const changes = workingTreeChanges(root);
  if (changes.tracked.length || changes.untracked.length) {
    throw new PublishRefusal(
      `Commit or remove local changes first: ${[...changes.tracked, ...changes.untracked].join(", ")}`,
    );
  }
  git(root, ["fetch", "--quiet", remote, branch]);
  const remoteHead = git(root, ["rev-parse", "FETCH_HEAD"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head === remoteHead) {
    throw new PublishRefusal(`${remote}/${branch} already points at ${head.slice(0, 9)}`);
  }
  if (!isAncestor(root, remoteHead, head)) {
    throw new PublishRefusal(
      `${remote}/${branch} moved to ${remoteHead.slice(0, 9)}, which this commit does not contain. Rebase or merge it, then publish again. Never force-push.`,
    );
  }
  // The pre-push hook runs the secret scan and fails when Gitleaks is missing.
  const gitleaks = findGitleaks(env);
  if (!gitleaks) {
    throw new PublishRefusal(
      "Gitleaks is not installed or not found. Install Gitleaks 8.30.1 for the pre-push secret scan.",
    );
  }
  const outgoing = git(root, ["log", "--format=%h %s", `${remoteHead}..${head}`]).split("\n");
  return { root, remote, branch, head, remoteHead, gitleaks, outgoing };
}

export function publish(plan, env = process.env) {
  const pathWithGitleaks = [path.dirname(plan.gitleaks), env.PATH ?? ""].join(path.delimiter);
  execFileSync("git", ["push", plan.remote, `HEAD:refs/heads/${plan.branch}`], {
    cwd: plan.root,
    env: { ...env, PATH: pathWithGitleaks },
    stdio: "inherit",
  });
  const published = git(plan.root, ["ls-remote", plan.remote, `refs/heads/${plan.branch}`]).split(
    /\s+/,
  )[0];
  if (published !== plan.head) {
    throw new PublishRefusal(
      `${plan.remote}/${plan.branch} reports ${published?.slice(0, 9) ?? "nothing"} after the push, not ${plan.head.slice(0, 9)}`,
    );
  }
  return published;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["dry-run"],
    options: ["remote", "branch"],
  });
  const plan = preparePublication({
    cwd: process.cwd(),
    remote: args.remote ?? "origin",
    branch: args.branch ?? "main",
  });
  console.log(`Publishing ${plan.outgoing.length} commit(s) to ${plan.remote}/${plan.branch}:`);
  for (const line of plan.outgoing) console.log(`  ${line}`);
  if (args["dry-run"]) {
    console.log("Dry run: fast-forward, clean tree and secret scanner verified; nothing pushed.");
    return;
  }
  publish(plan);
  console.log(
    `Verified: ${plan.remote}/${plan.branch} is ${plan.head} and contains every outgoing commit.`,
  );
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
