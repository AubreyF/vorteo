import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderUsage } from "./types";

export function providerConnectionAction(input: {
  providerId: string;
  providers: MutableDaemonConfig["providers"] | undefined;
  usage: ProviderUsage | undefined;
}): "Connect" | "Reconnect" | null {
  if (input.usage?.authRecovery) return "Reconnect";
  const provider = input.providers?.[input.providerId];
  const accountProvider = accountProviderKind(input.providerId, input.providers);
  if (!accountProvider || provider?.enabled === false || input.usage?.status === "available")
    return null;
  return "Connect";
}

export function accountProviderKind(
  providerId: string,
  providers: MutableDaemonConfig["providers"] | undefined,
): "claude" | "codex" | null {
  const base = providers?.[providerId]?.extends ?? providerId;
  return base === "claude" || base === "codex" ? base : null;
}
