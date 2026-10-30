#!/usr/bin/env node
// Vorteo releases (docs/release.md, "Vorteo releases"). Versions are calendar versions
// (scripts/vorteo-version.mjs): beta is release-<version>-beta and stable is
// release-<version>, where <version> is the tagged commit's package.json version, such as
// release-26.10.3001-beta. The release- prefix matches none of upstream Paseo's release
// triggers, which use glob patterns such as v*, android-v* and app-v*; vorteo-* would match v*.
//
//   prepare --channel beta|stable [--date YYYY-MM-DD]
//          Sets the next calendar version in every manifest. Commit it with its changelog
//          entry on the channel's release branch, install it, then tag it.
//   list   [--channel beta|stable]                 Tags on the remote, newest first.
//   latest --channel beta|stable [--installed <version>]
//          Newest tag an installation on that channel should offer, or null. Beta also
//          offers stable. Legacy 0.11.0-beta.3.vorteo.<n> versions are older than any tag.
//   tag    --channel beta|stable --commit <ref> [--release] [--dry-run]
//          Tags a prepared commit on the channel's release branch. Stable needs a beta tag
//          on the same commit. Tags are permanent: never move, delete or reuse one.
//
// Common options: --remote origin, --branch <release branch>, --repo owner/name.
// Exit status 0 means done (or ready, for a dry run); 1 means refused.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findGitleaks, git, isAncestor, parseArgs, repositoryRoot } from "./lib/delivery-git.mjs";
import { resolveRepository, runGh } from "./lib/github.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { assertBuildsCoordinator } from "./lib/builds-guard.mjs";
import {
  CHANNELS,
  UNRELEASED,
  VersionError,
  changelogEntries,
  compareTags,
  compareVersions,
  isVersion,
  legacyCounter,
  nextVersion,
  parseTag,
  synchronizedManifests,
  tagName,
} from "./vorteo-version.mjs";

export class ReleaseRefusal extends Error {}

export { CHANNELS, tagName };

/**
 * The branch each channel releases from. Separate `beta` and `production` branches are
 * planned; until they exist both channels release from main. Change only this map then.
 */
export const RELEASE_BRANCHES = { beta: "main", stable: "main" };

function assertChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new ReleaseRefusal("Channel must be beta or stable.");
}

/** An installed version: a calendar version, a legacy counter version, or none. */
export function parseInstalled(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (legacyCounter(text) === null && !isVersion(text)) {
    throw new ReleaseRefusal(`${text} is not an installed Vorteo version.`);
  }
  return text;
}

/** Release tags from `git ls-remote --tags` output, using the peeled commit of annotated tags. */
export function parseRemoteTags(output) {
  const commits = new Map();
  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!ref?.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (!parseTag(name)) continue;
    if (peeled || !commits.has(name)) commits.set(name, sha);
  }
  return [...commits]
    .map(([name, commit]) => Object.assign(parseTag(name), { commit }))
    .sort(compareTags);
}

/** Tags an installation on `channel` may install: stable only, or beta plus stable. */
export function channelTags(tags, channel) {
  assertChannel(channel);
  return tags.filter((tag) => channel === "beta" || tag.channel === "stable");
}

/** The newest tag above the installed version, or null when the installation is current. */
export function latestFor(tags, channel, installed = null) {
  return (
    channelTags(tags, channel).find(
      (tag) => installed === null || compareVersions(tag.version, installed) > 0,
    ) ?? null
  );
}

export function remoteTags(root, remote) {
  return parseRemoteTags(git(root, ["ls-remote", "--tags", remote, "refs/tags/release-*"]));
}

/**
 * Changelog entries of the release `version` and of every release since `after` (a
 * version, or null for the first release), newest first. Unreleased entries count toward
 * the release prepared above them; legacy counter entries belong to no release.
 */
export function releaseNotes(changelog, after, version, limit = 30) {
  const entries = changelogEntries(changelog).filter(
    ({ release }) =>
      release !== null &&
      isVersion(release) &&
      compareVersions(release, version) <= 0 &&
      (after === null || compareVersions(release, after) > 0),
  );
  const shown = entries.slice(0, limit).map((entry) => entry.text);
  if (entries.length > limit) {
    shown.push(`And ${entries.length - limit} earlier entries in VORTEO_CHANGELOG.md.`);
  }
  return shown.join("\n\n");
}

function todayFrom(date) {
  if (date === undefined) return undefined;
  const match = /^20(\d{2})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new ReleaseRefusal("--date must be YYYY-MM-DD.");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Writes the next calendar version into every manifest and the lockfile. The version is
 * one build past every tag of either channel and the current manifest on the same day.
 */
export function prepareVersion({ cwd, channel, remote = "origin", date, tags }) {
  assertChannel(channel);
  const root = repositoryRoot(cwd);
  const current = JSON.parse(git(root, ["show", "HEAD:package.json"])).version;
  const known = (tags ?? remoteTags(root, remote)).map((tag) => tag.version);
  let version;
  try {
    version = nextVersion([current, ...known], todayFrom(date));
  } catch (error) {
    if (error instanceof VersionError) throw new ReleaseRefusal(error.message);
    throw error;
  }
  for (const [file, value] of synchronizedManifests(root, version)) {
    writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  }
  return { root, channel, version, previous: current, branch: RELEASE_BRANCHES[channel] };
}

/** Checks a tag request against the release branch and existing tags without changing anything. */
export function prepareTag({ cwd, channel, commit, remote = "origin", branch }) {
  assertChannel(channel);
  // A GitHub merge commit shares its head's version, so the commit is always explicit:
  // the one the installation actually installed.
  if (!commit) throw new ReleaseRefusal("Name the installed commit with --commit.");
  const releaseBranch = branch ?? RELEASE_BRANCHES[channel];
  const root = repositoryRoot(cwd);
  git(root, ["fetch", "--quiet", remote, releaseBranch]);
  const branchHead = git(root, ["rev-parse", "FETCH_HEAD"]);
  const sha = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (!isAncestor(root, sha, branchHead)) {
    throw new ReleaseRefusal(
      `${sha.slice(0, 9)} is not on ${remote}/${releaseBranch}. Release tags go only on merged commits.`,
    );
  }
  const version = JSON.parse(git(root, ["show", `${sha}:package.json`])).version;
  if (!isVersion(version)) {
    throw new ReleaseRefusal(
      `${version} is not a calendar version. Run vorteo-release.mjs prepare and commit it first.`,
    );
  }
  // Commits after a release preparation keep its version; only the prepared state is that
  // release, so nothing may wait as Unreleased above its changelog entry.
  const [top] = changelogEntries(git(root, ["show", `${sha}:VORTEO_CHANGELOG.md`]));
  if (top?.label !== version) {
    throw new ReleaseRefusal(
      `${sha.slice(0, 9)} has ${top?.label === UNRELEASED ? "Unreleased changes" : "no changelog entry"} above ${version}. Prepare a new version for it.`,
    );
  }
  const name = tagName(channel, version);
  const tags = remoteTags(root, remote);
  if (tags.some((tag) => tag.name === name)) {
    throw new ReleaseRefusal(`${name} already exists. Tags are permanent; fix forward.`);
  }
  const newest = tags.find((tag) => tag.channel === channel);
  if (newest && compareVersions(newest.version, version) >= 0) {
    throw new ReleaseRefusal(
      `${newest.name} is already as new as ${version}; installations would never offer ${name}.`,
    );
  }
  if (channel === "stable") {
    const beta = tags.find((tag) => tag.name === tagName("beta", version));
    if (!beta || beta.commit !== sha) {
      throw new ReleaseRefusal(
        `Stable needs ${tagName("beta", version)} on ${sha.slice(0, 9)} first, so stable installs code that already ran as beta.`,
      );
    }
  }
  const previous = newest?.version ?? null;
  return { root, remote, channel, commit: sha, version, name, previous };
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

/**
 * Writes the tagged commit's `install.sh` to a private temporary file for upload, or
 * returns null for a commit that predates the one-command installer.
 */
function installerAsset(plan) {
  let script;
  try {
    script = git(plan.root, ["show", `${plan.commit}:install.sh`]);
  } catch {
    return null;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "vorteo-release-"));
  const file = path.join(directory, "install.sh");
  writeFileSync(file, script.endsWith("\n") ? script : `${script}\n`, { mode: 0o600 });
  return file;
}

/**
 * Publishes a GitHub Release for the tag; beta releases are prereleases and never "latest".
 * The release carries `install.sh`, which https://github.com/terran-labs/vorteo/releases/latest/download/install.sh redirects to.
 */
export function createRelease(plan, { gh = runGh, repository } = {}) {
  const changelog = git(plan.root, ["show", `${plan.commit}:VORTEO_CHANGELOG.md`]);
  const notes = releaseNotes(changelog, plan.previous, plan.version) || "No changelog entries.";
  const channelFlags = plan.channel === "beta" ? ["--prerelease", "--latest=false"] : ["--latest"];
  const asset = installerAsset(plan);
  gh(
    [
      "release",
      "create",
      plan.name,
      ...(asset ? [asset] : []),
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
    options: ["channel", "installed", "commit", "remote", "branch", "repo", "date"],
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
  if (command === "prepare") {
    const prepared = prepareVersion({ cwd: root, channel: args.channel, remote, date: args.date });
    console.log(`Prepared ${prepared.version} (was ${prepared.previous}).`);
    console.log(
      `Add "## ${prepared.version} - YYYY-MM-DD" to VORTEO_CHANGELOG.md, commit both, and merge to ${prepared.branch}.`,
    );
    return;
  }
  if (command !== "tag") {
    throw new ReleaseRefusal("Usage: vorteo-release.mjs prepare|list|latest|tag …");
  }
  const plan = prepareTag({
    cwd: root,
    channel: args.channel,
    commit: args.commit,
    remote,
    branch: args.branch,
  });
  console.log(`${plan.name} -> ${plan.commit} (${plan.version})`);
  if (args["dry-run"]) {
    console.log(
      "Dry run: the commit is prepared and on its release branch, the tag is new and the channel rules hold.",
    );
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
