import type { z } from "zod";
import type { ClaudeSetupConnectionSchema } from "./claude-setup-login";

export function claudeConnectionStatus(
  connection: z.infer<typeof ClaudeSetupConnectionSchema> | undefined,
): string {
  return installationConnectionStatus(connection, "Claude");
}

/** Status of one installation-wide connection, for Claude or Codex. */
export function installationConnectionStatus(
  connection: z.infer<typeof ClaudeSetupConnectionSchema> | undefined,
  provider: "Claude" | "Codex",
): string {
  if (!connection) return "Checking connection status…";
  const status = sharedStatus(connection, provider);
  return connection.accountLabel ? `${status} Signed in as ${connection.accountLabel}.` : status;
}

function sharedStatus(
  connection: z.infer<typeof ClaudeSetupConnectionSchema>,
  provider: "Claude" | "Codex",
): string {
  if (connection.needsSignIn)
    return `${provider} sign-in expired on the Host. Sign in again to keep Host and Dev working.`;
  const environments = connection.environments.filter((entry) => entry.status !== "excluded");
  if (environments.some((entry) => entry.status === "disconnecting"))
    return "Disconnecting. Credential removal will finish automatically when connections return.";
  if (!connection.connected) return "Not connected.";
  if (environments.length === 0 && connection.environments.length > 0)
    return "Connected. Current environment exclusions prevent use.";
  // Host-owned sign-in lists only Dev deliveries; the Host uses its own sign-in directly.
  const hostOnly = connection.needsSignIn !== undefined && connection.environments.length === 0;
  if (
    hostOnly ||
    (environments.length > 0 && environments.every((entry) => entry.status === "ready"))
  )
    return "Connected and ready.";
  return "Connected. Synchronization is pending and will retry automatically. You do not need to sign in again.";
}
