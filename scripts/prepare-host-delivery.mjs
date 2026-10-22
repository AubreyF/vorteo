#!/usr/bin/env node
// Prepares a Host source update from GitHub main without discarding anything
// the Host already runs. The installation's updater requires the update to
// descend from the installed source, and it folds in published interface
// records, so both must be merged before main.
//
// Usage: node scripts/prepare-host-delivery.mjs --checkout <dir>
//          --source-repo <installation source repository> --installed <commit>
//          [--target origin/main] [--branch installation-integration]
//
// Each run takes one step and stops: it creates or resets the delivery
// checkout at the installed commit, or starts the next merge (published
// records first, then the target). Release-note conflicts are resolved by
// keeping both sides; any other conflict is left for you. Finish the merge
// with the normal version and changelog workflow, commit, and run again until
// it reports the checkout is ready to submit.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, hasCommit, isAncestor, parseArgs, repositoryRoot } from "./lib/delivery-git.mjs";
import { isMainModule } from "./is-main-module.mjs";

export const UNION_FILES = ["VORTEO_CHANGELOG.md", "docs/vorteo-customizations.md"];
const PUBLICATION_PREFIX = "refs/delivery-publications/";

/** Keeps both sides of every conflict hunk, ours first. For append-only notes. */
export function unionConflicts(text) {
  const lines = text.split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("<<<<<<< ")) {
      output.push(lines[index]);
      continue;
    }
    const ours = [];
    const theirs = [];
    index += 1;
    while (index < lines.length && !lines[index].startsWith("=======")) ours.push(lines[index++]);
    index += 1;
    while (index < lines.length && !lines[index].startsWith(">>>>>>> "))
      theirs.push(lines[index++]);
    if (ours.length && ours.at(-1) !== "" && theirs.length) ours.push("");
    output.push(...ours, ...theirs);
  }
  return output.join("\n");
}

// Both lines bump the Vorteo version on every commit, so manifests conflict on
// version strings alone. Those hunks keep the installed side; the version
// workflow sets the final number when the merge is committed.
const VORTEO_VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?\.(?:vorteo|vorton)\.\d+/g;

/** Resolves conflict hunks that differ only in Vorteo version strings. */
export function resolveVersionOnlyConflicts(text) {
  const lines = text.split("\n");
  const output = [];
  let unresolved = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("<<<<<<< ")) {
      output.push(lines[index]);
      continue;
    }
    const start = index;
    const ours = [];
    const theirs = [];
    index += 1;
    while (index < lines.length && !lines[index].startsWith("=======")) ours.push(lines[index++]);
    index += 1;
    while (index < lines.length && !lines[index].startsWith(">>>>>>> "))
      theirs.push(lines[index++]);
    const mask = (side) => side.join("\n").replace(VORTEO_VERSION, "<version>");
    if (mask(ours) === mask(theirs)) output.push(...ours);
    else {
      unresolved += 1;
      output.push(...lines.slice(start, index + 1));
    }
  }
  return { text: output.join("\n"), unresolved };
}

function conflictedFiles(cwd) {
  const output = git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return output ? output.split("\n") : [];
}

export function prepareHostDelivery({
  repository,
  checkout,
  sourceRepo,
  installed,
  target = "origin/main",
  branch = "installation-integration",
}) {
  if (!existsSync(checkout)) {
    git(path.dirname(checkout), ["clone", "--quiet", "--no-checkout", repository, checkout]);
  }
  const remoteName = target.split("/")[0];
  const upstreamUrl = git(repository, ["remote", "get-url", remoteName], { allowFailure: true });
  if (upstreamUrl) {
    if (git(checkout, ["remote", "get-url", remoteName], { allowFailure: true }) === null) {
      git(checkout, ["remote", "add", remoteName, upstreamUrl]);
    } else git(checkout, ["remote", "set-url", remoteName, upstreamUrl]);
    git(checkout, ["fetch", "--quiet", remoteName]);
  }
  git(checkout, ["fetch", "--quiet", sourceRepo, installed]);
  git(
    checkout,
    [
      "fetch",
      "--quiet",
      "--force",
      sourceRepo,
      `+refs/vorteo-publications/*:${PUBLICATION_PREFIX}*`,
    ],
    { allowFailure: true },
  );
  if (!hasCommit(checkout, target)) throw new Error(`${target} is unavailable in the checkout`);

  const inMerge = hasCommit(checkout, "MERGE_HEAD");
  if (inMerge) {
    return { state: "merging", conflicts: conflictedFiles(checkout), checkout };
  }
  const current = git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  const onBranch = current === branch && hasCommit(checkout, "HEAD");
  if (!onBranch) {
    git(checkout, ["checkout", "--quiet", "-B", branch, installed]);
    return { state: "reset", head: installed, checkout };
  }
  const status = git(checkout, ["status", "--porcelain"]);
  if (status) throw new Error(`The delivery checkout has uncommitted changes:\n${status}`);

  // A newer installed release is merged rather than reset to, so earlier
  // merges in this checkout are never discarded.
  const publications = git(checkout, ["for-each-ref", "--format=%(objectname)", PUBLICATION_PREFIX])
    .split("\n")
    .filter(Boolean);
  const next =
    [installed, ...publications, target].find((commit) => !isAncestor(checkout, commit, "HEAD")) ??
    null;
  if (!next) {
    return { state: "ready", head: git(checkout, ["rev-parse", "HEAD"]), checkout, branch };
  }

  // A newer installed release that already contains this branch needs no merge commit.
  if (isAncestor(checkout, "HEAD", next)) {
    git(checkout, ["merge", "--quiet", "--ff-only", next]);
    return { state: "fast-forwarded", head: git(checkout, ["rev-parse", "HEAD"]), checkout };
  }
  git(checkout, ["merge", "--no-ff", "--no-commit", next], { allowFailure: true });
  for (const file of conflictedFiles(checkout)) {
    const full = path.join(checkout, file);
    const text = readFileSync(full, "utf8");
    if (UNION_FILES.includes(file)) {
      writeFileSync(full, unionConflicts(text));
      git(checkout, ["add", file]);
    } else if (/(^|\/)package(-lock)?\.json$/.test(file)) {
      const resolved = resolveVersionOnlyConflicts(text);
      writeFileSync(full, resolved.text);
      if (resolved.unresolved === 0) git(checkout, ["add", file]);
    }
  }
  const conflicts = conflictedFiles(checkout);
  return {
    state: "merging",
    merging: next,
    subject: git(checkout, ["log", "-1", "--format=%s", next]),
    conflicts,
    checkout,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    options: ["checkout", "source-repo", "installed", "target", "branch"],
  });
  for (const required of ["checkout", "source-repo", "installed"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const result = prepareHostDelivery({
    repository: repositoryRoot(process.cwd()),
    checkout: path.resolve(args.checkout),
    sourceRepo: path.resolve(args["source-repo"]),
    installed: args.installed,
    target: args.target ?? "origin/main",
    branch: args.branch ?? "installation-integration",
  });
  if (result.state === "fast-forwarded") {
    console.log(`Fast-forwarded the delivery checkout to ${result.head.slice(0, 9)}. Run again.`);
  } else if (result.state === "reset") {
    console.log(
      `Delivery checkout reset to the installed commit ${result.head.slice(0, 9)}. Run again.`,
    );
  } else if (result.state === "merging") {
    console.log(
      `Merging ${result.merging ? `${/^[0-9a-f]{40}$/.test(result.merging) ? result.merging.slice(0, 9) : result.merging} ${result.subject}` : "in progress"}.`,
    );
    if (result.conflicts.length) {
      console.log(`Resolve these conflicts first: ${result.conflicts.join(", ")}`);
    }
    console.log(
      "Then run npm run version:vorton, add the changelog entry, commit, and run this script again.",
    );
  } else {
    console.log(`Ready: ${result.checkout} on ${result.branch} at ${result.head.slice(0, 9)}.`);
    console.log(
      "Push it to GitHub main with scripts/publish-main.mjs, then submit it with the installation client's request-restart --target host --update --repository command.",
    );
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
