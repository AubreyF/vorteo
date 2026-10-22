// Installers record the installation's Projects folder in each daemon's
// `$PASEO_HOME/projects-folder.json`. Both daemons see the folder at the same absolute
// path, through an identical bind mount or, in an existing container, a symlink to its
// older mount that is recorded as an alias. See docs/execution-installation.md#projects-folder.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Container scripts read and write the file with this path relative to `PASEO_HOME`. */
export const PROJECTS_FOLDER_SETTINGS_PATH = "projects-folder.json";

function absoluteList(values, label) {
  for (const value of values ?? []) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute paths`);
  }
  return [...new Set((values ?? []).map((value) => path.resolve(value)))];
}

/**
 * Returns the settings text with `root` set and earlier locations and aliases merged in.
 * Unknown keys are kept, and a file that is not a JSON object is refused rather than
 * replaced.
 */
export function mergeProjectsFolderSettings(
  existingText,
  { root, migrateFrom = [], aliases = [], allowOutside = [], keepPaths = [] },
) {
  if (!path.isAbsolute(root)) throw new Error("The Projects folder must be an absolute path");
  let settings = {};
  if (existingText?.trim()) {
    try {
      settings = JSON.parse(existingText);
    } catch {
      throw new Error("The Projects folder settings file is not valid JSON; fix it first");
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new Error("The Projects folder settings file must hold a JSON object");
  }
  const merge = (current, added, label) => {
    const next = absoluteList([...(Array.isArray(current) ? current : []), ...added], label);
    return next.length ? next : undefined;
  };
  const notRoot = (value) => value !== path.resolve(root);
  const next = {
    ...settings,
    root: path.resolve(root),
    migrateFrom: merge(settings.migrateFrom, migrateFrom, "Earlier locations")?.filter(notRoot),
    aliases: merge(settings.aliases, aliases, "Aliases")?.filter(notRoot),
    allowOutside: merge(settings.allowOutside, allowOutside, "Allowed folders"),
    keepPaths: merge(settings.keepPaths, keepPaths, "Kept paths"),
  };
  for (const key of ["migrateFrom", "aliases", "allowOutside", "keepPaths"])
    if (!next[key]?.length) delete next[key];
  return JSON.stringify(next, null, 2) + "\n";
}

/** Writes a daemon's settings file in place, privately and atomically. */
export function writeProjectsFolderSettings({ paseoHome, ...input }) {
  const file = path.join(paseoHome, PROJECTS_FOLDER_SETTINGS_PATH);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const next = mergeProjectsFolderSettings(existing, input);
  if (next === existing) return { file, changed: false };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
  return { file, changed: true };
}

/** True when `candidate` is `folder` or inside it. */
export function isInsideFolder(folder, candidate) {
  const relative = path.relative(path.resolve(folder), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Where writable bind mounts show the host `folder` inside the container. */
export function containerPathsOfFolder(mounts, folder) {
  return (mounts ?? [])
    .filter(
      (mount) =>
        mount.Type === "bind" &&
        mount.RW !== false &&
        mount.Source &&
        mount.Destination &&
        isInsideFolder(mount.Source, folder),
    )
    .map((mount) => path.posix.join(mount.Destination, path.relative(mount.Source, folder)));
}

/** True when a bind mount shows `folder` inside the container at the same absolute path. */
export function mountsFolderAtIdenticalPath(mounts, folder) {
  return containerPathsOfFolder(mounts, folder).includes(folder);
}

/**
 * The commands Builds runs once in an existing container, as root, to give it the folder's
 * identical path as a symlink to `mountPath`, and as the daemon user to verify it.
 */
export function projectsFolderAliasCommands(folder, mountPath) {
  const q = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  return {
    root: `mkdir -p ${q(path.posix.dirname(folder))} && test ! -e ${q(folder)} && ln -s ${q(mountPath)} ${q(folder)}`,
    verify: `readlink ${q(folder)} && test "$(cd ${q(folder)} && pwd -P)" = ${q(mountPath)}`,
  };
}
