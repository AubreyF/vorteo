import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Durable sessions are off unless this file enables them. It lives outside config.json on purpose:
 * config.json is parsed strictly, so a new key there would stop an older release from starting
 * after a rollback. Older releases ignore this file.
 */
export const DURABLE_SESSIONS_SETTINGS_FILE = "durable-sessions.json";

const DurableSessionsSettingsSchema = z.looseObject({ enabled: z.boolean() });

export interface DurableSessionsSettings {
  enabled: boolean;
  /** Why the setting is off when the file exists but cannot be used. */
  problem?: string;
}

export function durableSessionsSettingsPath(paseoHome: string): string {
  return path.join(paseoHome, DURABLE_SESSIONS_SETTINGS_FILE);
}

/** Read on every decision, so turning the setting off affects new sessions without a restart. */
export function readDurableSessionsSettings(paseoHome: string): DurableSessionsSettings {
  let raw: string;
  try {
    raw = readFileSync(durableSessionsSettingsPath(paseoHome), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
    return { enabled: false, problem: "The durable sessions setting could not be read." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: false, problem: "The durable sessions setting is not valid JSON." };
  }
  const settings = DurableSessionsSettingsSchema.safeParse(parsed);
  if (!settings.success)
    return { enabled: false, problem: 'The durable sessions setting needs {"enabled": true}.' };
  return { enabled: settings.data.enabled };
}
