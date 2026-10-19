import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

export const EnvironmentSchema = z.enum(["host", "dev"]);
export type Environment = z.infer<typeof EnvironmentSchema>;
const TargetSchema = z.strictObject({
  endpoint: z.string().regex(/^127\.0\.0\.1:\d+$/),
  password: z.string().min(1),
  serverId: z.string().min(1),
});
export const ConfigSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535),
  token: z.string().min(32),
  stateDirectory: z.string().startsWith("/"),
  origin: z.url(),
  host: TargetSchema,
  dev: TargetSchema,
});
export type BridgeConfig = z.infer<typeof ConfigSchema>;
export type Target = z.infer<typeof TargetSchema>;

export function readConfig(file: string): BridgeConfig {
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error("Bridge configuration must be a private file (0600)");
  return ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
