// Shares installed dependencies between checkouts through APFS copy-on-write
// clones. One "golden" install is kept per lockfile and install mode; each
// checkout receives its own cloned node_modules trees, so workspace links
// (node_modules/@getpaseo/x -> ../../packages/x) still resolve inside that
// checkout. A shared symlinked node_modules would not: Node resolves symlinks
// to real paths, sending every workspace import into one checkout.
//
// Clones share disk blocks until a file changes, so a cloned install costs
// metadata only. Unsupported platforms, and VORTEO_DEPENDENCY_CACHE=0, run a
// normal `npm ci` instead.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FORMAT = 1;
const HOUR = 60 * 60_000;
// Keep a few recent lockfiles (main, a release branch, an in-flight upgrade).
const KEEP_ENTRIES = 4;
const MANIFEST = "manifest.json";

/** npm arguments per mode. "build" matches the snapshot builders, which apply
 * dependency patches explicitly; "worktree" matches a developer `npm ci`. */
export const installModes = {
  build: ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"],
  worktree: ["ci", "--no-audit", "--no-fund"],
};

export function defaultDependencyCache(env = process.env) {
  return (
    env.VORTEO_DEPENDENCY_CACHE_DIR || path.join(os.homedir(), ".cache", "vorteo-dependencies")
  );
}

export function cloneSupported({ platform = process.platform, env = process.env } = {}) {
  return platform === "darwin" && env.VORTEO_DEPENDENCY_CACHE !== "0";
}

/** "" for the root, then every workspace directory recorded by the lockfile. */
export function workspaceDirectories(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const workspaces = Object.keys(lock.packages ?? {}).filter(
    (key) => key && !key.split("/").includes("node_modules"),
  );
  return ["", ...workspaces.sort()];
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** Drops our own package versions, which the version hook changes on every
 * commit. npm links workspaces whatever their version, so third-party
 * contents, the part worth caching, stay the same. */
function withoutWorkspaceVersions(manifest, workspaceNames) {
  const result = { ...manifest };
  delete result.version;
  for (const field of DEPENDENCY_FIELDS) {
    if (!result[field]) continue;
    result[field] = { ...result[field] };
    for (const name of Object.keys(result[field]))
      if (workspaceNames.has(name)) result[field][name] = "workspace";
  }
  return result;
}

/** Everything that can change what `npm ci` writes into node_modules. */
export function dependencyKey(root, mode, { npmVersion } = {}) {
  const hash = crypto.createHash("sha256");
  hash.update(
    JSON.stringify({
      format: FORMAT,
      mode,
      args: installModes[mode],
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      npm: npmVersion ?? null,
    }),
  );
  const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  const directories = workspaceDirectories(root);
  const manifests = directories.map((directory) =>
    read(path.posix.join(directory, "package.json")),
  );
  const workspaceNames = new Set(manifests.map((manifest) => manifest.name).filter(Boolean));
  for (const [index, directory] of directories.entries())
    hash.update(
      `\0${directory}/package.json\0` +
        JSON.stringify(withoutWorkspaceVersions(manifests[index], workspaceNames)),
    );
  const lock = read("package-lock.json");
  delete lock.version;
  for (const directory of directories)
    if (lock.packages?.[directory])
      lock.packages[directory] = withoutWorkspaceVersions(lock.packages[directory], workspaceNames);
  hash.update("\0package-lock.json\0" + JSON.stringify(lock));
  const inputs = [".npmrc"];
  if (mode === "worktree") {
    // Lifecycle scripts run in this mode; root postinstall applies patches/.
    inputs.push("scripts/postinstall-patches.mjs");
    const patches = path.join(root, "patches");
    if (fs.existsSync(patches))
      for (const name of fs.readdirSync(patches).sort()) inputs.push(`patches/${name}`);
  }
  for (const relative of inputs) {
    const file = path.join(root, relative);
    hash.update(`\0${relative}\0`);
    if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex").slice(0, 32);
}

function defaultRun(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

/** clonefile(2) per file; data blocks stay shared until either copy changes. */
function defaultClone(from, to) {
  execFileSync("/bin/cp", ["-c", "-R", from, to], { stdio: "inherit" });
}

function readManifest(entry) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(entry, MANIFEST), "utf8"));
    return manifest.format === FORMAT && Array.isArray(manifest.directories) ? manifest : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function removeInstalled(root) {
  for (const directory of workspaceDirectories(root))
    fs.rmSync(path.join(root, directory, "node_modules"), { recursive: true, force: true });
}

function cloneInto(root, entry, manifest, clone) {
  for (const relative of manifest.directories) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    clone(path.join(entry, "tree", relative), target);
  }
  // npm writes this hidden lockfile last; its absence means an incomplete tree.
  if (!fs.existsSync(path.join(root, "node_modules", ".package-lock.json")))
    throw new Error("Cloned dependencies are incomplete");
}

function capture(root, cache, key, mode, clone) {
  const entry = path.join(cache, key);
  if (readManifest(entry)) return;
  const staging = fs.mkdtempSync(path.join(cache, `.staging-${key}-`));
  try {
    const directories = workspaceDirectories(root)
      .map((directory) => path.posix.join(directory, "node_modules"))
      .filter((relative) => fs.existsSync(path.join(root, relative)));
    for (const relative of directories) {
      const target = path.join(staging, "tree", relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      clone(path.join(root, relative), target);
    }
    fs.writeFileSync(
      path.join(staging, MANIFEST),
      JSON.stringify({
        format: FORMAT,
        key,
        mode,
        directories,
        createdAt: new Date().toISOString(),
      }),
    );
    // Publish complete entries only. A concurrent capture of the same key wins harmlessly.
    fs.renameSync(staging, entry);
  } catch (error) {
    if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Removes old entries and abandoned staging directories. Entries used in the
 * last hour stay, so a running clone never loses its source. */
export function pruneDependencyCache(cache, { now = Date.now(), keep = KEEP_ENTRIES } = {}) {
  if (!fs.existsSync(cache)) return [];
  const removed = [];
  const entries = [];
  for (const name of fs.readdirSync(cache)) {
    const entry = path.join(cache, name);
    if (name.startsWith(".staging-")) {
      if (now - fs.statSync(entry).mtimeMs > 24 * HOUR) {
        fs.rmSync(entry, { recursive: true, force: true });
        removed.push(name);
      }
      continue;
    }
    const manifest = path.join(entry, MANIFEST);
    if (!fs.existsSync(manifest)) continue;
    entries.push({ name, entry, usedAt: fs.statSync(manifest).mtimeMs });
  }
  entries.sort((a, b) => b.usedAt - a.usedAt);
  for (const { name, entry, usedAt } of entries.slice(keep)) {
    if (now - usedAt < HOUR) continue;
    fs.rmSync(entry, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Installs dependencies into `root` as `npm ci` would for the given mode.
 * Returns { source: "clone" | "install", key? }.
 */
export function installDependencies({
  root,
  mode,
  cache = defaultDependencyCache(),
  run = defaultRun,
  clone = defaultClone,
  supported = cloneSupported(),
  npmVersion,
  log = (message) => console.log(message),
}) {
  const args = installModes[mode];
  if (!args) throw new Error(`Unknown dependency install mode: ${mode}`);
  if (!supported) {
    run("npm", args, root);
    return { source: "install" };
  }
  fs.mkdirSync(cache, { recursive: true });
  const version =
    npmVersion ?? execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim();
  const key = dependencyKey(root, mode, { npmVersion: version });
  const entry = path.join(cache, key);
  const manifest = readManifest(entry);
  if (manifest) {
    const now = new Date();
    fs.utimesSync(path.join(entry, MANIFEST), now, now);
    removeInstalled(root);
    try {
      const started = Date.now();
      cloneInto(root, entry, manifest, clone);
      // Clones skip root lifecycle scripts that write outside node_modules.
      if (mode === "worktree") run("npm", ["run", "prepare", "--if-present"], root);
      log(`Dependencies cloned from ${entry} in ${Math.round((Date.now() - started) / 1000)}s`);
      return { source: "clone", key };
    } catch (error) {
      log(`Dependency clone failed, installing instead: ${error.message}`);
      removeInstalled(root);
    }
  }
  run("npm", args, root);
  try {
    capture(root, cache, key, mode, clone);
    pruneDependencyCache(cache);
  } catch (error) {
    // The install itself succeeded; a cache failure only costs the next checkout time.
    log(`Dependency cache not updated: ${error.message}`);
  }
  return { source: "install", key };
}
