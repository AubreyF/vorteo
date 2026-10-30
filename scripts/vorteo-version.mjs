// Vorteo calendar versions (docs/release.md, "Vorteo versions"), after Freed's scheme:
// YY.M.DDNN, where YY is the two-digit year, M the month and DDNN the day times 100 plus a
// build number from 0 through 99, with no leading zeros. 26.10.3000 is build 0 on
// October 30, 2026 and 26.10.3001 the next release that day. Manifests always carry the
// plain version; the beta channel lives only on the tag (release-26.10.3001-beta).
//
// Installations from before calendar versions report 0.11.0-beta.3.vorteo.<counter>.
// Those legacy versions sort below every calendar version, so they are offered upgrades.
// Uses only Node built-ins: scripts/release/latest.mjs imports it without dependencies.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const CHANNELS = ["beta", "stable"];
/** The first calendar version year. Upstream Paseo's 0.x versions never reach it. */
export const FIRST_YEAR = 26;
// Windows installers limit the major component to 255; Freed checks the same bound.
const LAST_YEAR = 255;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LEGACY = /^\d+\.\d+\.\d+(?:-beta\.\d+)?[.-](?:vorteo|vorton)\.([1-9]\d*)$/;
const TAG = /^release-(\d+\.\d+\.\d+)(-beta)?$/;

export class VersionError extends Error {}

/**
 * Parses a calendar version such as 26.10.3001.
 * @returns {{ version: string, year: number, month: number, day: number, build: number }}
 */
export function parseVersion(input) {
  const text = String(input ?? "").trim();
  const match = VERSION.exec(text);
  if (!match) {
    throw new VersionError(
      `${JSON.stringify(text)} is not a Vorteo version such as 26.10.3001 (YY.M.DDNN, no leading zeros).`,
    );
  }
  const [year, month, patch] = match.slice(1).map(Number);
  const day = Math.floor(patch / 100);
  const build = patch % 100;
  if (year < FIRST_YEAR || year > LAST_YEAR) {
    throw new VersionError(
      `${text} has year ${year}; expected ${FIRST_YEAR} through ${LAST_YEAR}.`,
    );
  }
  if (month < 1 || month > 12) throw new VersionError(`${text} has month ${month}.`);
  if (day < 1 || day > 31) throw new VersionError(`${text} encodes day ${day}.`);
  return { version: text, year, month, day, build };
}

export function isVersion(input) {
  try {
    parseVersion(input);
    return true;
  } catch {
    return false;
  }
}

/** The per-commit counter of a version from before calendar versions, or null. */
export function legacyCounter(input) {
  const match = LEGACY.exec(String(input ?? "").trim());
  return match ? Number(match[1]) : null;
}

export function formatVersion({ year, month, day, build }) {
  if (!Number.isInteger(build) || build < 0 || build > 99) {
    throw new VersionError(`Build ${build} is outside 0 through 99.`);
  }
  return parseVersion(`${year}.${month}.${day * 100 + build}`).version;
}

/**
 * Orders two installed or release versions. Every legacy counter version is older than
 * every calendar version; legacy versions order by counter. Anything else is refused.
 */
export function compareVersions(left, right) {
  const rank = (value) => {
    const counter = legacyCounter(value);
    if (counter !== null) return [0, counter, 0, 0];
    const parsed = parseVersion(value);
    return [1, parsed.year, parsed.month, parsed.day * 100 + parsed.build];
  };
  const a = rank(left);
  const b = rank(right);
  const index = a.findIndex((value, position) => value !== b[position]);
  return index === -1 ? 0 : Math.sign(a[index] - b[index]);
}

/** The local calendar day, as Freed's release script reads it with `date`. */
export function calendarDay(date = new Date()) {
  return { year: date.getFullYear() % 100, month: date.getMonth() + 1, day: date.getDate() };
}

/**
 * The next release version on `today`: build 0, or one past the highest build already used
 * that day by any version in `taken` (tags of either channel and the current manifest).
 * Refuses when a taken version is from a later day, which means the clock is wrong.
 */
export function nextVersion(taken, today = calendarDay()) {
  const key = (value) => [value.year, value.month, value.day];
  let build = 0;
  for (const value of taken) {
    if (legacyCounter(value) !== null) continue;
    const parsed = parseVersion(value);
    const order = compareKeys(key(parsed), key(today));
    if (order > 0) {
      throw new VersionError(`${value} is later than today; check the clock before releasing.`);
    }
    if (order === 0) build = Math.max(build, parsed.build + 1);
  }
  if (build > 99) throw new VersionError("Today already has 100 releases; release tomorrow.");
  return formatVersion({ ...today, build });
}

function compareKeys(a, b) {
  const index = a.findIndex((value, position) => value !== b[position]);
  return index === -1 ? 0 : Math.sign(a[index] - b[index]);
}

/** release-26.10.3001 for stable, release-26.10.3001-beta for beta. */
export function tagName(channel, version) {
  if (!CHANNELS.includes(channel)) throw new VersionError("Channel must be beta or stable.");
  const plain = parseVersion(version).version;
  return channel === "stable" ? `release-${plain}` : `release-${plain}-beta`;
}

/** The version and channel a release tag names, or null for any other tag. */
export function parseTag(name) {
  const match = TAG.exec(String(name ?? ""));
  if (!match || !isVersion(match[1])) return null;
  return { name: match[0], version: match[1], channel: match[2] ? "beta" : "stable" };
}

/** Newest first; for one version, stable before beta. */
export function compareTags(left, right) {
  const channelOrder = (tag) => (tag.channel === "stable" ? 0 : 1);
  return compareVersions(right.version, left.version) || channelOrder(left) - channelOrder(right);
}

/** Heading label for changelog entries that no release has picked up yet. */
export const UNRELEASED = "Unreleased";
const HEADING = /^## (\S+) - (\d{4}-\d{2}-\d{2})\s*$/;

/**
 * VORTEO_CHANGELOG.md entries, newest first. Each commit adds an `Unreleased` entry and
 * release preparation adds one headed by the new version, so an `Unreleased` entry belongs
 * to the nearest versioned entry above it (`release`), or to no release yet (null).
 * @returns {{ label: string, date: string, release: string | null, text: string }[]}
 */
export function changelogEntries(changelog) {
  let release = null;
  return changelog
    .split(/^(?=## )/m)
    .filter((block) => block.startsWith("## "))
    .map((block) => {
      const text = block.trim();
      const heading = text.split("\n")[0];
      const match = HEADING.exec(heading);
      const label = match?.[1] ?? heading.slice(3).trim();
      // Newest first: a versioned entry starts the release every older Unreleased entry joins.
      if (label !== UNRELEASED) release = label;
      return {
        label,
        date: match?.[2] ?? "",
        release: label === UNRELEASED ? release : label,
        text,
      };
    });
}

// Manifests -----------------------------------------------------------------------------

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The manifest files that carry the version: root, every workspace, then the lockfile. */
export function manifestFiles(root) {
  return [
    "package.json",
    ...root.workspaces.map((workspace) => `${workspace}/package.json`),
    "package-lock.json",
  ];
}

/**
 * Every manifest and the lockfile rewritten to `version`, with internal dependency pins
 * following it. Reads from `cwd`; writes nothing.
 * @returns {[string, object][]}
 */
export function synchronizedManifests(cwd, version) {
  const root = readJson(path.join(cwd, "package.json"));
  const files = manifestFiles(root);
  const packages = files.slice(0, -1).map((file) => [file, readJson(path.join(cwd, file))]);
  const names = new Set(packages.map(([, pkg]) => pkg.name));
  const lock = readJson(path.join(cwd, "package-lock.json"));
  for (const [file, pkg] of packages) {
    pkg.version = version;
    for (const section of SECTIONS) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        if (names.has(name) && name !== pkg.name) pkg[section][name] = pkg.private ? "*" : version;
      }
    }
    const key = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
    const entry = lock.packages[key];
    if (!entry) throw new VersionError(`Missing workspace lock entry: ${key}`);
    entry.version = version;
    for (const section of SECTIONS) {
      for (const name of Object.keys(entry[section] ?? {})) {
        if (names.has(name) && pkg[section]?.[name]) entry[section][name] = pkg[section][name];
      }
    }
  }
  lock.version = version;
  return [...packages, ["package-lock.json", lock]];
}

/** The root manifest version at a commit, or null when the commit has none. */
export function versionAt(cwd, commit) {
  try {
    const text = execFileSync("git", ["show", `${commit}:package.json`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(text).version ?? null;
  } catch {
    return null;
  }
}
