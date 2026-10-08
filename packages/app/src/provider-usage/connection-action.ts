import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderUsage } from "./types";

export function providerConnectionAction(input: {
  providerId: string;
  providers: MutableDaemonConfig["providers"] | undefined;
  usage: ProviderUsage | undefined;
  snapshot?: Pick<ProviderSnapshotEntry, "provider" | "status" | "enabled">;
}): "Connect" | "Reconnect" | null {
  if (input.usage?.authRecovery) return "Reconnect";
  const provider = input.providers?.[input.providerId];
  const accountProvider = accountProviderKind(input.providerId, input.providers);
  if (!accountProvider || provider?.enabled === false || input.usage?.status === "available")
    return null;
  // Claude readiness includes the CLI's account-scoped auth status check. Quota
  // access can still be unavailable, notably for credentials kept in macOS Keychain.
  const claudeAuthenticated =
    accountProvider === "claude" &&
    input.snapshot?.provider === input.providerId &&
    input.snapshot.enabled &&
    input.snapshot.status === "ready";
  if (claudeAuthenticated) return null;
  return "Connect";
}

export function accountProviderKind(
  providerId: string,
  providers: MutableDaemonConfig["providers"] | undefined,
): "claude" | "codex" | null {
  const base = providers?.[providerId]?.extends ?? providerId;
  return base === "claude" || base === "codex" ? base : null;
}
