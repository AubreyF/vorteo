import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Durable sessions are off unless this file enables them. It lives outside config.json on purpose:
 * config.json is parsed strictly, so a new key there would stop an older release from starting
 * after a rollback. Older releases ignore this file.
 */
export const DURABLE_SESSIONS_SETTINGS_FILE = "durable-sessions.json";

const DurableSessionsSettingsSchema = z.looseObject({
  enabled: z.boolean(),
  /** How long a hosted session must be idle before a pending host upgrade releases it. */
  idleReleaseMs: z.number().int().positive().optional(),
  /** How often the host compares its release with the installed one. */
  releaseCheckMs: z.number().int().positive().optional(),
});

export interface DurableSessionsSettings {
  enabled: boolean;
  /** Why the setting is off when the file exists but cannot be used. */
  problem?: string;
  idleReleaseMs?: number;
  releaseCheckMs?: number;
}

/** Idle hosted sessions are released for an upgrade after this long without activity. */
export const DEFAULT_IDLE_RELEASE_MS = 5 * 60_000;
/** The host looks for a newer installed release this often. */
export const DEFAULT_RELEASE_CHECK_MS = 60_000;

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
  const { enabled, idleReleaseMs, releaseCheckMs } = settings.data;
  return {
    enabled,
    ...(idleReleaseMs !== undefined ? { idleReleaseMs } : {}),
    ...(releaseCheckMs !== undefined ? { releaseCheckMs } : {}),
  };
}
