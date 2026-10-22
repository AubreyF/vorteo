// Disk hygiene for scripts/build-instance-web.mjs. Each build snapshots the
// source and installs about 3 GB of dependencies; once its export is sealed
// only the export matters. Builds that were never cleaned up filled the Host
// disk on 2026-10-22, so every build now trims itself and prunes stale ones.
import fs from "node:fs/promises";
import path from "node:path";

const HOUR = 60 * 60_000;
export const ownerFile = ".build-owner.json";
// Sealed exports are small; keep a few for re-publication or comparison.
const KEEP_EXPORTS = 5;
const EXPORT_DAYS = 7;
// Builds from before this cleanup have no owner file; give them time to finish.
const UNOWNED_HOURS = 6;
const RETAINED = new Set(["web-export", ".build-source-commit", ownerFile]);

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
  { current, now = Date.now(), isAlive = alive } = {},
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
    const build = await describe(root).catch(() => null);
    if (!build) continue;
    if (build.owner && Number.isInteger(build.owner.pid) && isAlive(build.owner.pid)) continue;
    const age = now - build.mtimeMs;
    const finished = build.sealed && !(await hasSnapshot(root));
    if (finished) {
      exports.push({ name, root, mtimeMs: build.mtimeMs });
      continue;
    }
    // Failed, interrupted or pre-cleanup builds still hold their snapshot.
    if (age < (build.owner ? HOUR : UNOWNED_HOURS * HOUR)) continue;
    await fs.rm(root, { recursive: true, force: true });
    removed.push(name);
  }
  exports.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, { name, root, mtimeMs }] of exports.entries()) {
    if (index < KEEP_EXPORTS && now - mtimeMs < EXPORT_DAYS * 24 * HOUR) continue;
    await fs.rm(root, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

async function hasSnapshot(root) {
  return (await fs.readdir(root)).some((name) => !RETAINED.has(name));
}
