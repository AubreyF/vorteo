// Git refuses a repository whose files it reads as owned by another user ("dubious
// ownership") unless `safe.directory` names it. A Dev container that reaches the Projects
// folder through a symlink sees the real, physical path, and git before 2.46 ignores the
// `<folder>/*` wildcard, so every repository needs its own entry. The daemon trusts the
// repository it runs git in for that one invocation, by its exact physical top-level
// directory, and only inside the Projects folder or its aliases. Nothing is written to any
// git config, and paths elsewhere get no override.
//
// Git 2.39 compares only the working tree's top level: for a linked worktree that is the
// worktree itself, not its main checkout, so one entry covers it. See
// docs/execution-installation.md#projects-folder.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ProcessEnvRecord } from "./paseo-env.js";
import { activeProjectsFolderConfig, type ProjectsFolderConfig } from "./projects-folder.js";

type FolderPaths = Pick<ProjectsFolderConfig, "root" | "aliases">;

function isAtOrBelow(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nativeRealpath(value: string): string | null {
  try {
    return realpathSync.native(value);
  } catch {
    return null;
  }
}

interface FolderLocation {
  base: string;
  isRoot: boolean;
}

/**
 * The folder location (root or alias) holding `physical`, or null when it is outside. Each
 * location is tried as written and then by its real path, so a root spelled with a Windows
 * 8.3 short name still holds the long-name path that realpath returns.
 */
function containingFolderPath(config: FolderPaths, physical: string): FolderLocation | null {
  const locations = [config.root, ...config.aliases].map((base, index) => ({
    base: path.resolve(base),
    isRoot: index === 0,
  }));
  const canonical = locations.flatMap((location) => {
    const real = nativeRealpath(location.base);
    return real && real !== location.base ? [{ ...location, base: real }] : [];
  });
  // Stable sort: on equal length a location as written wins over another's real path.
  return (
    [...locations, ...canonical]
      .filter((location) => isAtOrBelow(location.base, physical))
      .toSorted((left, right) => right.base.length - left.base.length)[0] ?? null
  );
}

/**
 * The `safe.directory` value for a real top-level directory. Git for Windows reports and
 * compares its working tree with forward slashes (`C:/Users/...`), and versions before 2.46
 * compare the configured value as text, so Windows paths are passed in that form.
 */
export function gitSafeDirectoryValue(directory: string): string {
  return process.platform === "win32" ? directory.replaceAll("\\", "/") : directory;
}

export interface RepositoryTopLevel {
  /** Real path of the repository's top-level directory, as git reports and checks it. */
  physical: string;
  /** True when it lies under an alias of the folder rather than its logical root. */
  throughAlias: boolean;
}

/**
 * Finds the repository holding `cwd` without running git: resolves symlinks and walks up
 * to the nearest `.git` entry (a directory, or a file in a linked worktree), never above
 * the folder location that contains it. Null outside the folder or outside any repository.
 */
export function findProjectsFolderRepository(
  config: FolderPaths,
  cwd: string,
): RepositoryTopLevel | null {
  // The native resolver expands Windows 8.3 short names, as git does.
  const physical = nativeRealpath(cwd);
  if (!physical) return null;
  const location = containingFolderPath(config, physical);
  if (!location) return null;
  for (let directory = physical; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, ".git"))) {
      return { physical: directory, throughAlias: !location.isRoot };
    }
    if (path.relative(location.base, directory) === "" || path.dirname(directory) === directory)
      return null;
  }
}

const GIT_CONFIG_COUNT = "GIT_CONFIG_COUNT";

/**
 * Returns the variables that add `safe.directory=<directory>` for each directory through
 * git's `GIT_CONFIG_COUNT` environment (git 2.31 or later), after any entries the
 * effective environment already defines. `effective` reads a variable as the child will
 * see it. Returns an empty overlay when an existing count is not a number, since git
 * rejects that environment either way.
 */
export function safeDirectoryEnv(
  directories: readonly string[],
  effective: (name: string) => string | undefined,
): ProcessEnvRecord {
  if (directories.length === 0) return {};
  const current = effective(GIT_CONFIG_COUNT)?.trim() ?? "";
  if (current !== "" && !/^\d+$/u.test(current)) return {};
  const start = current === "" ? 0 : Number(current);
  const overlay: ProcessEnvRecord = {};
  directories.forEach((directory, index) => {
    overlay[`GIT_CONFIG_KEY_${start + index}`] = "safe.directory";
    overlay[`GIT_CONFIG_VALUE_${start + index}`] = directory;
  });
  overlay[GIT_CONFIG_COUNT] = String(start + directories.length);
  return overlay;
}

// Repository lookups by cwd for the active folder. Only found repositories are cached, so
// a folder that later becomes a repository is picked up on its next command.
const CACHE_LIMIT = 2048;
let cachedFor: FolderPaths | null = null;
const cachedTopLevels = new Map<string, string>();

function cachedRepositoryTopLevel(config: FolderPaths, cwd: string): string | null {
  if (cachedFor !== config) {
    cachedFor = config;
    cachedTopLevels.clear();
  }
  const cached = cachedTopLevels.get(cwd);
  if (cached) return cached;
  const found = findProjectsFolderRepository(config, cwd)?.physical ?? null;
  if (found) {
    if (cachedTopLevels.size >= CACHE_LIMIT) cachedTopLevels.clear();
    cachedTopLevels.set(cwd, found);
  }
  return found;
}

/**
 * The environment overlay that trusts the repository at `cwd` for one git invocation when
 * it is inside this daemon's Projects folder or one of its aliases, merged over `overlay`.
 * Returns `overlay` unchanged otherwise.
 */
export function withProjectsFolderSafeDirectory(
  cwd: string,
  overlay: ProcessEnvRecord | undefined,
  baseEnv: ProcessEnvRecord = process.env,
): ProcessEnvRecord | undefined {
  const config = activeProjectsFolderConfig();
  if (!config) return overlay;
  const topLevel = cachedRepositoryTopLevel(config, cwd);
  if (!topLevel) return overlay;
  const additions = safeDirectoryEnv([gitSafeDirectoryValue(topLevel)], (name) =>
    overlay && name in overlay ? overlay[name] : baseEnv[name],
  );
  return Object.keys(additions).length > 0 ? { ...overlay, ...additions } : overlay;
}
