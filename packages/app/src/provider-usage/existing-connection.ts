import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { groupInstallationProviders } from "@/screens/settings/shared-providers-model";
import type { ProviderUsage } from "./types";

export type AccountProvider = "claude" | "codex";

/** A Claude or Codex connection that already exists before the owner adds another. */
export interface ExistingConnection {
  providerId: string;
  name: string;
  /** The CLI's own default sign-in, not an account added through Vorteo. */
  isDefault: boolean;
  /** Created through Vorteo's account setup, so installation sign-in can share it. */
  setup: boolean;
  enabled: boolean;
  /** The provider reports usage for it, so its sign-in works. */
  signedIn: boolean;
  /** Plan label from the usage reading, for example "pro" or "Max 20x". */
  plan: string | null;
}

export const ACCOUNT_PROVIDER_LABELS: Record<AccountProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};

interface ConnectionInput {
  provider: AccountProvider;
  /** Shared settings definitions; undefined outside an installation. */
  definitions: readonly InstallationProvider[] | undefined;
  /** The environment whose bindings, usage and catalog are read: the Host in an installation. */
  serverId: string;
  usage: readonly ProviderUsage[] | undefined;
  /** Provider catalog entries on that environment; a ready entry means its CLI was found. */
  entries: readonly { provider: string; status: string; label?: string }[] | undefined;
}

/**
 * Connections the owner already has for one provider. Accounts added through Vorteo always
 * count. A default CLI connection counts once it is signed in or its CLI was detected, so an
 * Add account flow can say so before it creates a second account.
 */
export function existingConnections(input: ConnectionInput): ExistingConnection[] {
  const candidates = input.definitions
    ? definitionCandidates(input.provider, input.definitions, input.serverId)
    : catalogCandidates(input.provider, input.entries);
  const connections: ExistingConnection[] = [];
  for (const candidate of candidates) {
    const usage = input.usage?.find((item) => item.providerId === candidate.providerId);
    const entry = input.entries?.find((item) => item.provider === candidate.providerId);
    const signedIn = usage?.status === "available" && !usage.authRecovery;
    const detected = entry?.status === "ready";
    if (!candidate.isDefault || signedIn || detected)
      connections.push({
        providerId: candidate.providerId,
        name: candidate.name,
        isDefault: candidate.isDefault,
        setup: candidate.setup,
        enabled: candidate.enabled,
        signedIn,
        plan: usage?.planLabel ?? null,
      });
  }
  return connections;
}

interface Candidate {
  providerId: string;
  name: string;
  isDefault: boolean;
  setup: boolean;
  enabled: boolean;
}

function definitionCandidates(
  provider: AccountProvider,
  definitions: readonly InstallationProvider[],
  serverId: string,
): Candidate[] {
  const family = groupInstallationProviders(definitions).find((entry) => entry.id === provider);
  const candidates: Candidate[] = [];
  for (const account of family?.accounts ?? []) {
    const bound = account.definitions.find((entry) => entry.bindings[serverId]);
    if (!bound) continue;
    const isDefault = account.id === `default/${provider}`;
    candidates.push({
      providerId: bound.bindings[serverId]!,
      name: isDefault ? ACCOUNT_PROVIDER_LABELS[provider] : account.name,
      isDefault,
      setup: account.definitions.some((entry) => entry.accountSetup !== undefined),
      enabled: account.enabled,
    });
  }
  return candidates;
}

/** Outside an installation the daemon's catalog is the only list of connections. */
function catalogCandidates(
  provider: AccountProvider,
  entries: ConnectionInput["entries"],
): Candidate[] {
  return (entries ?? [])
    .filter(
      (entry) => entry.provider === provider || entry.provider.startsWith(`${provider}-account-`),
    )
    .map((entry) => ({
      providerId: entry.provider,
      name: entry.label ?? ACCOUNT_PROVIDER_LABELS[provider],
      isDefault: entry.provider === provider,
      setup: entry.provider !== provider,
      enabled: true,
    }));
}

/** "Claude 1", or the default sign-in described by where it lives and its plan. */
export function describeExistingConnection(
  connection: ExistingConnection,
  where: "Host" | "host",
): string {
  if (!connection.isDefault) return connection.name;
  const plan = connection.plan ? ` (${connection.plan})` : "";
  if (connection.signedIn) return `${where} CLI sign-in${plan}`;
  return `${where} CLI, sign-in not confirmed`;
}
