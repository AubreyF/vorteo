#!/usr/bin/env node
// Resolves the Vorteo release that new installs and in-app upgrades use: the newest
// `release-<counter>` tag (stable) or the newest tag of either kind (beta), as tagged by
// scripts/vorteo-release.mjs after the install tests pass, or the one VORTEO_VERSION pins.
// Never `main`. It uses only Node built-ins and the global fetch.
//
// Usage: node scripts/release/latest.mjs [--channel stable|beta] [--version <tag or counter>]
//                                        [--repository <owner/repo>]
// Prints {"tag","commit","counter","channel","assetUrl"} as JSON. Exit status 0 means
// resolved, 2 means no release exists yet (or the pin names none), and 1 means the lookup
// failed. GITHUB_TOKEN or GH_TOKEN raises the API rate limit.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The one place this package names the GitHub home. Change it here when the owner moves.
export const REPOSITORY = "terran-labs/vorteo";
export const INSTALL_ASSET = "install.sh";
const API_URL = "https://api.github.com";
// docs/release.md#vorteo-releases. Upstream `v*` tags never match.
const TAG_PATTERN = /^release-([1-9]\d*)(-beta)?$/;

export class ReleaseResolutionError extends Error {
  /** @param {"not-found" | "invalid" | "api"} code */
  constructor(code, message) {
    super(message);
    this.name = "ReleaseResolutionError";
    this.code = code;
  }
}

/** Accepts `release-940`, `release-940-beta` or the counter `940` (stable). */
export function normalizeTag(value) {
  const text = String(value).trim();
  const tag = /^[1-9]\d*$/.test(text) ? `release-${text}` : text;
  if (!TAG_PATTERN.test(tag)) {
    throw new ReleaseResolutionError(
      "invalid",
      `VORTEO_VERSION ${JSON.stringify(value)} is not a release such as release-940 or 940.`,
    );
  }
  return tag;
}

function parseTag(tag) {
  const match = TAG_PATTERN.exec(tag ?? "");
  return match ? { counter: Number(match[1]), channel: match[2] ? "beta" : "stable" } : null;
}

function installAsset(release) {
  return release?.assets?.find(
    (asset) => asset.name === INSTALL_ASSET && asset.state === "uploaded",
  );
}

/** A published Vorteo release on `channel` that carries the installer. */
export function isInstallable(release, channel) {
  const tag = parseTag(release?.tag_name);
  return Boolean(
    tag &&
    release.draft === false &&
    (channel === "beta" || tag.channel === "stable") &&
    installAsset(release),
  );
}

async function request(fetchImpl, url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "vorteo-release-resolver",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new ReleaseResolutionError("api", `Could not reach GitHub: ${error.message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429;
    throw new ReleaseResolutionError(
      "api",
      `GitHub answered ${response.status} for ${new URL(url).pathname}.${limited ? " Set GITHUB_TOKEN to raise the rate limit." : ""}`,
    );
  }
  return response.json();
}

async function findRelease({ fetchImpl, base, token, pinned, channel }) {
  if (pinned) {
    const release = await request(fetchImpl, `${base}/releases/tags/${pinned}`, token);
    if (!release || release.draft || !installAsset(release)) {
      throw new ReleaseResolutionError(
        "not-found",
        `VORTEO_VERSION ${pinned} is not a published release with ${INSTALL_ASSET}.`,
      );
    }
    return release;
  }
  if (channel === "stable") {
    const latest = await request(fetchImpl, `${base}/releases/latest`, token);
    if (isInstallable(latest, channel)) return latest;
  }
  const recent = (await request(fetchImpl, `${base}/releases?per_page=100`, token)) ?? [];
  const newest = recent
    .filter((release) => isInstallable(release, channel))
    .sort((a, b) => parseTag(b.tag_name).counter - parseTag(a.tag_name).counter)[0];
  if (!newest) {
    throw new ReleaseResolutionError("not-found", `No ${channel} Vorteo release exists yet.`);
  }
  return newest;
}

/**
 * @param {{ repository?: string, version?: string, channel?: "stable" | "beta", token?: string,
 *   fetch?: typeof fetch, apiUrl?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ tag: string, commit: string, counter: number, channel: string, assetUrl: string }>}
 */
export async function resolveRelease(options = {}) {
  const env = options.env ?? process.env;
  const repository = options.repository ?? REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ReleaseResolutionError(
      "invalid",
      `Repository must be owner/name, not ${repository}.`,
    );
  }
  const channel = options.channel ?? env.VORTEO_CHANNEL ?? "stable";
  if (channel !== "stable" && channel !== "beta") {
    throw new ReleaseResolutionError("invalid", "Channel must be stable or beta.");
  }
  const requested = options.version ?? env.VORTEO_VERSION;
  const pinned = requested ? normalizeTag(requested) : null;
  const token = options.token ?? (env.GITHUB_TOKEN || env.GH_TOKEN || undefined);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl ?? API_URL}/repos/${repository}`;

  const release = await findRelease({ fetchImpl, base, token, pinned, channel });
  const tag = release.tag_name;
  // The commits endpoint dereferences lightweight and annotated tags alike.
  const commit = (await request(fetchImpl, `${base}/commits/${encodeURIComponent(tag)}`, token))
    ?.sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new ReleaseResolutionError("api", `GitHub returned no commit for ${tag}.`);
  }
  const parsed = parseTag(tag);
  return {
    tag,
    commit,
    counter: parsed.counter,
    channel: parsed.channel,
    assetUrl: installAsset(release).browser_download_url,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!["--version", "--repository", "--channel"].includes(flag) || !value) {
      throw new ReleaseResolutionError(
        "invalid",
        "Usage: latest.mjs [--channel stable|beta] [--version <tag or counter>] [--repository <owner/repo>]",
      );
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const real = (file) => {
    try {
      return realpathSync.native(file);
    } catch {
      return file;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(path.resolve(process.argv[1]));
}

if (isEntryPoint()) {
  try {
    const release = await resolveRelease(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(release)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.code === "not-found" ? 2 : 1;
  }
}
