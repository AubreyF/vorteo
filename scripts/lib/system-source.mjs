// Installers record which checkout an installation was built from in the Vorteo System
// settings file, `$PASEO_HOME/system/system.json`. The daemon makes that checkout the
// System project's root. See docs/system-project.md.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Container scripts read and write the file with this path relative to `PASEO_HOME`. */
export const SYSTEM_SETTINGS_PATH = "system/system.json";

/**
 * Returns the settings text with `source.checkout` (and `source.ref` when given) set.
 * Every other key, such as `adopt` and `absorb`, is kept. A file that is not a JSON
 * object is refused rather than overwritten, so an operator's edits are never lost.
 */
export function mergeSystemSource(existingText, { checkout, ref }) {
  if (!path.isAbsolute(checkout)) throw new Error("The source checkout must be an absolute path");
  let settings = {};
  if (existingText?.trim()) {
    try {
      settings = JSON.parse(existingText);
    } catch {
      throw new Error("The Vorteo System settings file is not valid JSON; fix it first");
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new Error("The Vorteo System settings file must hold a JSON object");
  }
  const source =
    settings.source && typeof settings.source === "object" && !Array.isArray(settings.source)
      ? settings.source
      : {};
  return (
    JSON.stringify(
      { ...settings, source: { ...source, checkout, ...(ref ? { ref } : {}) } },
      null,
      2,
    ) + "\n"
  );
}

/** Writes the Host's settings file in place, privately and atomically. */
export function writeSystemSource({ paseoHome, checkout, ref }) {
  const file = path.join(paseoHome, SYSTEM_SETTINGS_PATH);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const next = mergeSystemSource(existing, { checkout, ref });
  if (next === existing) return { file, changed: false };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
  return { file, changed: true };
}

/**
 * Where a Host checkout appears inside a container, from `docker inspect` mounts, or
 * null when no bind mount shares it. The deepest matching mount wins.
 */
export function containerCheckoutPath(mounts, checkout) {
  let best = null;
  for (const mount of mounts ?? []) {
    if (mount.Type !== "bind" || !mount.Source || !mount.Destination) continue;
    const relative = path.relative(mount.Source, checkout);
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    if (!best || mount.Source.length > best.source.length)
      best = { source: mount.Source, path: path.posix.join(mount.Destination, relative) };
  }
  return best?.path ?? null;
}
