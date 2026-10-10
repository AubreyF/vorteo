import type { z } from "zod";
import type { ClaudeSetupConnectionSchema } from "./claude-setup-login";

export function claudeConnectionStatus(
  connection: z.infer<typeof ClaudeSetupConnectionSchema> | undefined,
): string {
  if (!connection) return "Checking connection status…";
  const environments = connection.environments.filter((entry) => entry.status !== "excluded");
  if (environments.some((entry) => entry.status === "disconnecting"))
    return "Disconnecting. Credential removal will finish automatically when connections return.";
  if (!connection.connected) return "Not connected.";
  if (environments.length === 0 && connection.environments.length > 0)
    return "Connected. Current environment exclusions prevent use.";
  if (environments.length > 0 && environments.every((entry) => entry.status === "ready"))
    return "Connected and ready.";
  return "Connected. Synchronization is pending and will retry automatically. You do not need to sign in again.";
}
