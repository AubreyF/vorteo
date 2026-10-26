// Disk hygiene for scripts/build-instance-web.mjs. Each build snapshots the
// source and installs about 3 GB of dependencies; once its export is sealed
// only the export matters. Builds that were never cleaned up filled the Host
// disk on 2026-10-22, so every build now trims itself and prunes stale ones.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOUR = 60 * 60_000;
export const ownerFile = ".build-owner.json";
// Sealed exports are small; keep a few for re-publication or comparison.
const KEEP_EXPORTS = 5;
const EXPORT_DAYS = 7;
// Builds from before this cleanup have no owner file; give them time to finish.
const UNOWNED_HOURS = 6;
const RETAINED = new Set(["web-export", ".build-source-commit", ownerFile]);
const PRUNE_LOCK = ".prune-lock";
const pruner = fileURLToPath(new URL("../prune-instance-builds.mjs", import.meta.url));

export async function claimBuild(root, { pid = process.pid } = {}) {
  await fs.writeFile(
    path.join(root, ownerFile),
    JSON.stringify({ pid, startedAt: new Date().toISOString() }),
    { flag: "wx" },
  );
}

/** Keep the sealed export and its source stamp; drop the snapshot and dependencies. */
export async function trimSealedBuild(root) {
  for (const name of await fs.readdir(root)) {
    if (!RETAINED.has(name)) await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function describe(root) {
  const owner = await fs
    .readFile(path.join(root, ownerFile), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const stat = await fs.stat(root);
  const sealed = await fs
    .stat(path.join(root, "web-export", ".build-manifest.json"))
    .then(() => true)
    .catch(() => false);
  return { owner, mtimeMs: stat.mtimeMs, sealed };
}

/**
 * Remove abandoned builds and old exports under `builds`, never touching
 * `current` or a build whose owning process is still running.
 */
export async function pruneInstanceBuilds(
  builds,
  { current, now = Date.now(), isAlive = alive, onError = () => {}, remove = removeTree } = {},
) {
  const names = await fs.readdir(builds).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const removed = [];
  const exports = [];
  for (const name of names) {
    const root = path.join(builds, name);
    if (!name.startsWith("build-") || root === current) continue;
    const verdict = await classifyBuild(root, { now, isAlive });
    if (verdict.kind === "export") exports.push({ name, root, mtimeMs: verdict.mtimeMs });
    else if (verdict.kind === "abandoned" && (await removeBuild(root, remove, onError)))
      removed.push(name);
  }
  exports.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, { name, root, mtimeMs }] of exports.entries()) {
    if (index < KEEP_EXPORTS && now - mtimeMs < EXPORT_DAYS * 24 * HOUR) continue;
    if (await removeBuild(root, remove, onError)) removed.push(name);
  }
  return removed;
}

/**
 * Decide one build's fate without touching it: `keep` (missing, in use, changing
 * or too recent), `export` (sealed and trimmed; subject to export retention) or
 * `abandoned` (failed, interrupted or pre-cleanup, and old enough to remove).
 */
async function classifyBuild(root, { now, isAlive }) {
  const build = await describe(root).catch(() => null);
  if (!build) return { kind: "keep" };
  if (build.owner && Number.isInteger(build.owner.pid) && isAlive(build.owner.pid))
    return { kind: "keep" };
  const snapshot = await hasSnapshot(root).catch(() => null);
  if (snapshot === null) return { kind: "keep" }; // Removed or changing under us; the next run decides.
  if (build.sealed && !snapshot) return { kind: "export", mtimeMs: build.mtimeMs };
  // Failed, interrupted or pre-cleanup builds still hold their snapshot.
  const age = now - build.mtimeMs;
  return age < (build.owner ? HOUR : UNOWNED_HOURS * HOUR)
    ? { kind: "keep" }
    : { kind: "abandoned" };
}

function removeTree(root) {
  // A concurrent deleter or a straggling writer can leave a directory briefly
  // non-empty mid-removal; Node retries ENOTEMPTY and EBUSY with backoff.
  return fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** One stubborn build must not stop the rest of the prune. */
async function removeBuild(root, remove, onError) {
  try {
    await remove(root);
    return true;
  } catch (error) {
    onError(root, error);
    return false;
  }
}

async function hasSnapshot(root) {
  return (await fs.readdir(root)).some((name) => !RETAINED.has(name));
}

/** Run pruning under a directory lock so concurrent builds do not repeat it.
 * Returns null when another live pruner holds the lock. */
export async function pruneInstanceBuildsOnce(builds, { isAlive = alive, ...options } = {}) {
  await fs.mkdir(builds, { recursive: true });
  const lock = path.join(builds, PRUNE_LOCK);
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await fs
      .readFile(path.join(lock, "owner.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (owner && Number.isInteger(owner.pid) && isAlive(owner.pid)) return null;
    // The previous pruner died; its lock protects nothing now.
    await fs.rm(lock, { recursive: true, force: true });
    await fs.mkdir(lock);
  }
  try {
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    return await pruneInstanceBuilds(builds, { isAlive, ...options });
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

/** Deleting gigabytes of old dependencies can take an hour under load, so a
 * build hands pruning to a detached, low-priority process and carries on. */
export function pruneInstanceBuildsInBackground(builds) {
  const nice = "/usr/bin/nice";
  const command = existsSync(nice) ? nice : process.execPath;
  const args = existsSync(nice) ? ["-n", "15", process.execPath, pruner, builds] : [pruner, builds];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
