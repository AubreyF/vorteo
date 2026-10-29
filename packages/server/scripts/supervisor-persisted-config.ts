import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as localConfig from "../src/server/persisted-config.js";
import { resolveManagedWorker } from "./managed-release.js";

/** A retained supervisor must validate configuration with the selected worker's schema.
 * Otherwise adding a valid worker setting can prevent the next container boot.
 * This selects trusted release code, never a module named by persisted configuration.
 */
export async function supervisorPersistedConfig(
  env: NodeJS.ProcessEnv,
): Promise<Pick<typeof localConfig, "readPersistedConfig" | "loadPersistedConfig">> {
  const worker = resolveManagedWorker(env);
  if (!worker) return localConfig;
  const reader = path.join(path.dirname(worker), "persisted-config.js");
  if (realpathSync(reader) !== reader || !statSync(reader).isFile())
    throw new Error("Managed configuration reader must be a regular file inside its release");
  const selected = await import(pathToFileURL(reader).href);
  if (resolveManagedWorker(env) !== worker)
    throw new Error("Managed release changed while loading its configuration reader");
  if (
    typeof selected.readPersistedConfig !== "function" ||
    typeof selected.loadPersistedConfig !== "function"
  )
    throw new Error("Managed configuration reader is incompatible with this supervisor");
  return selected;
}
