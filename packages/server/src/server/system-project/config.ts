import { promises as fs } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";

/**
 * `$PASEO_HOME/system/system.json`, written by the operator or installer.
 * Unknown keys are ignored so a newer file never stops an older daemon.
 */
export const SystemProjectConfigSchema = z
  .object({
    /** Existing workspace to move into a role instead of creating a new one, by exact ID. */
    adopt: z.record(z.string().min(1), z.string().regex(/^wks_[0-9a-f]+$/u)).optional(),
    /** Where "Set up Vorteo source" clones from and which commit or branch it checks out. */
    source: z
      .object({
        repository: z.string().min(1),
        ref: z.string().min(1).optional(),
      })
      .optional(),
  })
  .passthrough();

export type SystemProjectConfig = z.infer<typeof SystemProjectConfigSchema>;

export async function readSystemProjectConfig(
  filePath: string,
  logger: Pick<Logger, "warn">,
): Promise<SystemProjectConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    logger.warn({ err: error, filePath }, "Could not read Vorteo System settings; using defaults");
    return {};
  }
  const parsed = SystemProjectConfigSchema.safeParse(safeJson(raw));
  if (parsed.success) return parsed.data;
  logger.warn(
    { filePath, issues: parsed.error.issues },
    "Ignoring invalid Vorteo System settings; using defaults",
  );
  return {};
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
