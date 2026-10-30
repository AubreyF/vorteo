#!/usr/bin/env node
// Vorteo release tags (docs/release.md, "Vorteo releases"). Beta is release-<counter>-beta and
// stable is release-<counter>, where <counter> is the Vorteo version counter of the tagged
// commit. The release- prefix matches none of upstream Paseo's release triggers, which use
// glob patterns such as v*, android-v* and app-v*; vorteo-* would match v*.
//
//   list   [--channel beta|stable]                 Tags on the remote, newest first.
//   latest --channel beta|stable [--installed <n>] Newest tag an installation on that channel
//                                                  should offer, or null. Beta also offers stable.
//   tag    --channel beta|stable [--commit <ref>] [--release] [--dry-run]
//          Tags a commit on main. Stable needs a beta tag on the same commit. Tags are
//          permanent: never move, delete or reuse one; fix forward with a newer commit.
//
// Common options: --remote origin, --branch main, --repo owner/name.
// Exit status 0 means done (or ready, for a dry run); 1 means refused.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { findGitleaks, git, isAncestor, parseArgs, repositoryRoot } from "./lib/delivery-git.mjs";
import { resolveRepository, runGh } from "./lib/github.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { assertBuildsCoordinator } from "./lib/builds-guard.mjs";

export class ReleaseRefusal extends Error {}

export const CHANNELS = ["beta", "stable"];
const TAG = /^release-([1-9]\d*)(-beta)?$/;
const COUNTER = /\.(?:vorteo|vorton)\.([1-9]\d*)$|-(?:vorteo|vorton)\.([1-9]\d*)$/;

export function tagName(channel, counter) {
  return channel === "stable" ? `release-${counter}` : `release-${counter}-beta`;
}

/** Vorteo counter from a manifest version, for example 0.11.0-beta.3.vorteo.922 -> 922. */
export function versionCounter(version) {
  const match = COUNTER.exec(version ?? "");
  if (!match) throw new ReleaseRefusal(`${version} has no Vorteo counter.`);
  return Number(match[1] ?? match[2]);
}

export function parseInstalled(value) {
  if (value === undefined) return 0;
  return /^\d+$/.test(value) ? Number(value) : versionCounter(value);
}

/** Release tags from `git ls-remote --tags` output, using the peeled commit of annotated tags. */
export function parseRemoteTags(output) {
  const commits = new Map();
  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!ref?.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (!TAG.test(name)) continue;
    if (peeled || !commits.has(name)) commits.set(name, sha);
  }
  return [...commits]
    .map(([name, commit]) => {
      const [, counter, beta] = TAG.exec(name);
      return { name, commit, counter: Number(counter), channel: beta ? "beta" : "stable" };
    })
    .sort((a, b) => b.counter - a.counter || (a.channel === "stable" ? -1 : 1));
}

/** Tags an installation on `channel` may install: stable only, or beta plus stable. */
export function channelTags(tags, channel) {
  if (!CHANNELS.includes(channel)) throw new ReleaseRefusal("Channel must be beta or stable.");
  return tags.filter((tag) => channel === "beta" || tag.channel === "stable");
}

/** The newest tag above the installed counter, or null when the installation is current. */
export function latestFor(tags, channel, installed = 0) {
  return channelTags(tags, channel).find((tag) => tag.counter > installed) ?? null;
}

export function remoteTags(root, remote) {
  return parseRemoteTags(git(root, ["ls-remote", "--tags", remote, "refs/tags/release-*"]));
}

/** Changelog entries newer than `after` and up to `counter`, newest first. */
export function releaseNotes(changelog, after, counter, limit = 30) {
  const entries = changelog
    .split(/^(?=## )/m)
    .filter((entry) => entry.startsWith("## "))
    .filter((entry) => {
      const match = COUNTER.exec(entry.slice(3).split(" - ")[0].trim());
      const value = match ? Number(match[1] ?? match[2]) : 0;
      return value > after && value <= counter;
    });
  const shown = entries.slice(0, limit).map((entry) => entry.trim());
  if (entries.length > limit) {
    shown.push(`And ${entries.length - limit} earlier entries in VORTEO_CHANGELOG.md.`);
  }
  return shown.join("\n\n");
}

/** Checks a tag request against main and the existing tags without changing anything. */
export function prepareTag({ cwd, channel, commit, remote = "origin", branch = "main" }) {
  if (!CHANNELS.includes(channel)) throw new ReleaseRefusal("Channel must be beta or stable.");
  // A GitHub merge commit shares its head's counter, so the commit is always explicit:
  // the one the installation actually installed.
  if (!commit) throw new ReleaseRefusal("Name the installed commit with --commit.");
  const root = repositoryRoot(cwd);
  git(root, ["fetch", "--quiet", remote, branch]);
  const mainHead = git(root, ["rev-parse", "FETCH_HEAD"]);
  const sha = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (!isAncestor(root, sha, mainHead)) {
    throw new ReleaseRefusal(
      `${sha.slice(0, 9)} is not on ${remote}/${branch}. Release tags go only on merged commits.`,
    );
  }
  const version = JSON.parse(git(root, ["show", `${sha}:package.json`])).version;
  const counter = versionCounter(version);
  const name = tagName(channel, counter);
  const tags = remoteTags(root, remote);
  if (tags.some((tag) => tag.name === name)) {
    throw new ReleaseRefusal(`${name} already exists. Tags are permanent; fix forward.`);
  }
  const newest = tags.find((tag) => tag.channel === channel);
  if (newest && newest.counter >= counter) {
    throw new ReleaseRefusal(
      `${newest.name} is already newer than ${version}; installations would never offer ${name}.`,
    );
  }
  if (channel === "stable") {
    const beta = tags.find((tag) => tag.name === tagName("beta", counter));
    if (!beta || beta.commit !== sha) {
      throw new ReleaseRefusal(
        `Stable needs ${tagName("beta", counter)} on ${sha.slice(0, 9)} first, so stable installs code that already ran as beta.`,
      );
    }
  }
  const previous = newest?.counter ?? counter - 1;
  return { root, remote, channel, commit: sha, version, counter, name, previous };
}

/** Creates and pushes an annotated tag, then proves the remote tag resolves to the commit. */
export function createTag(plan, env = process.env) {
  const gitleaks = findGitleaks(env);
  if (!gitleaks) throw new ReleaseRefusal("Gitleaks is needed for the pre-push secret scan.");
  const label = `Vorteo ${plan.version} (${plan.channel})`;
  git(plan.root, ["tag", "--annotate", "--message", label, plan.name, plan.commit]);
  try {
    execFileSync("git", ["push", plan.remote, `refs/tags/${plan.name}`], {
      cwd: plan.root,
      env: { ...env, PATH: [path.dirname(gitleaks), env.PATH ?? ""].join(path.delimiter) },
      stdio: "inherit",
    });
  } catch (error) {
    // An unpushed local tag would block every retry.
    git(plan.root, ["tag", "--delete", plan.name], { allowFailure: true });
    throw error;
  }
  const pushed = remoteTags(plan.root, plan.remote).find((tag) => tag.name === plan.name);
  if (pushed?.commit !== plan.commit) {
    throw new ReleaseRefusal(
      `${plan.remote} reports ${plan.name} at ${pushed?.commit ?? "nothing"}.`,
    );
  }
  return pushed;
}

/** Publishes a GitHub Release for the tag; beta releases are prereleases and never "latest". */
export function createRelease(plan, { gh = runGh, repository } = {}) {
  const changelog = git(plan.root, ["show", `${plan.commit}:VORTEO_CHANGELOG.md`]);
  const notes = releaseNotes(changelog, plan.previous, plan.counter) || "No changelog entries.";
  const channelFlags = plan.channel === "beta" ? ["--prerelease", "--latest=false"] : ["--latest"];
  gh(
    [
      "release",
      "create",
      plan.name,
      "-R",
      repository,
      "--verify-tag",
      "--title",
      `Vorteo ${plan.version}${plan.channel === "beta" ? " beta" : ""}`,
      "--notes-file",
      "-",
      ...channelFlags,
    ],
    { input: `(AI Generated).\n\n${notes}\n` },
  );
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest, {
    flags: ["release", "dry-run"],
    options: ["channel", "installed", "commit", "remote", "branch", "repo"],
  });
  const remote = args.remote ?? "origin";
  const root = repositoryRoot(process.cwd());
  if (command === "list") {
    const tags = remoteTags(root, remote);
    for (const tag of args.channel ? tags.filter((t) => t.channel === args.channel) : tags) {
      console.log(`${tag.name}\t${tag.commit}`);
    }
    return;
  }
  if (command === "latest") {
    const tag = latestFor(remoteTags(root, remote), args.channel, parseInstalled(args.installed));
    console.log(JSON.stringify(tag));
    return;
  }
  if (command !== "tag") throw new ReleaseRefusal("Usage: vorteo-release.mjs list|latest|tag …");
  const plan = prepareTag({
    cwd: root,
    channel: args.channel,
    commit: args.commit,
    remote,
    branch: args.branch,
  });
  console.log(`${plan.name} -> ${plan.commit} (${plan.version})`);
  if (args["dry-run"]) {
    console.log("Dry run: commit is on main, the tag is new and the channel rules hold.");
    return;
  }
  assertBuildsCoordinator("Creating release tags");
  createTag(plan);
  console.log(`Verified: ${remote} has ${plan.name} at ${plan.commit}.`);
  if (args.release) {
    const repository = resolveRepository({ root, remote, explicit: args.repo });
    createRelease(plan, { repository });
    console.log(`Published the GitHub Release for ${plan.name} on ${repository}.`);
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
