// Installers record the installation's Projects folder in each daemon's
// `$PASEO_HOME/projects-folder.json`. Both daemons see the folder at the same absolute
// path. See docs/execution-installation.md#projects-folder.
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
 * Returns the settings text with `root` set and earlier locations merged in. Unknown
 * keys are kept, and a file that is not a JSON object is refused rather than replaced.
 */
export function mergeProjectsFolderSettings(
  existingText,
  { root, migrateFrom = [], allowOutside = [] },
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
  const next = {
    ...settings,
    root: path.resolve(root),
    migrateFrom: merge(settings.migrateFrom, migrateFrom, "Earlier locations")?.filter(
      (value) => value !== path.resolve(root),
    ),
    allowOutside: merge(settings.allowOutside, allowOutside, "Allowed folders"),
  };
  for (const key of ["migrateFrom", "allowOutside"]) if (!next[key]?.length) delete next[key];
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

/** True when a bind mount shows `folder` inside the container at the same absolute path. */
export function mountsFolderAtIdenticalPath(mounts, folder) {
  return (mounts ?? []).some(
    (mount) =>
      mount.Type === "bind" &&
      mount.RW !== false &&
      mount.Source &&
      mount.Destination &&
      isInsideFolder(mount.Source, folder) &&
      path.posix.join(mount.Destination, path.relative(mount.Source, folder)) === folder,
  );
}
