import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import {
  existingConnections,
  type AccountProvider,
  type ExistingConnection,
} from "@/provider-usage/existing-connection";
import type { ProviderUsage } from "@/provider-usage/types";
import { groupInstallationProviders } from "@/screens/settings/shared-providers-model";

export type { AccountProvider };

/** One provider row on the first screen. */
export interface AccountsFirstConnection {
  provider: AccountProvider;
  /** A provider the owner turned off neither appears nor holds the screen open. */
  enabled: boolean;
  /** Who is connected: an account added through Vorteo, or the Host's own CLI sign-in. */
  connection: ExistingConnection | null;
}

/**
 * Each provider's real connection state for the first screen.
 *
 * Accounts added through Vorteo carry `accountSetup` and always count. With connect-once on
 * for a provider (`claudeHostRefresh` or `codexHostRefresh`), a default connection that the
 * Host CLI has signed in counts too, so an adopted installation whose Host is already signed
 * in is not asked to connect again. With connect-once off, a default sign-in stays local to
 * its environment and the screen still offers to connect an installation account.
 */
export function accountsFirstConnections(input: {
  definitions: readonly InstallationProvider[] | undefined;
  hostServerId: string;
  hostUsage: readonly ProviderUsage[] | undefined;
  connectOnce: Readonly<Record<AccountProvider, boolean>>;
}): AccountsFirstConnection[] {
  return ACCOUNTS_FIRST_PROVIDERS.map((provider) => {
    const family = groupInstallationProviders(input.definitions ?? []).find(
      (entry) => entry.id === provider,
    );
    const connections = existingConnections({
      provider,
      definitions: input.definitions ?? [],
      serverId: input.hostServerId,
      usage: input.hostUsage,
      entries: undefined,
    }).filter(
      (connection) => connection.setup || (connection.signedIn && input.connectOnce[provider]),
    );
    const connection =
      connections.find((entry) => entry.enabled && entry.setup) ??
      connections.find((entry) => entry.enabled) ??
      connections[0] ??
      null;
    // A provider without any definition yet is still offered.
    return { provider, enabled: family?.enabled ?? true, connection };
  });
}

export const ACCOUNTS_FIRST_PROVIDERS: readonly AccountProvider[] = ["claude", "codex"];

/** True when every enabled provider already has a connection. */
export function everyProviderConnected(connections: readonly AccountsFirstConnection[]): boolean {
  return connections.every((entry) => !entry.enabled || entry.connection !== null);
}

/** Sign-ins run on the Host, as on the Accounts page; Dev is the fallback for older layouts. */
export function accountsFirstServerId(
  environments: readonly InstallationEnvironment[],
): string | null {
  const host = environments.find((environment) => environment.kind === "host");
  const dev = environments.find((environment) => environment.kind === "container");
  return (host ?? dev)?.serverId ?? null;
}

export type AccountsFirstDecision = "pending" | "show" | "hide";

/**
 * Decide once per visit whether to show the first screen. A shown screen stays until the owner
 * leaves it, so a sign-in that creates an account mid-flow never unmounts its own panel.
 */
export function decideAccountsFirst(input: {
  previous: AccountsFirstDecision;
  installationId: string | null;
  hydrated: boolean;
  dismissed: readonly string[];
  connections:
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; connections: readonly AccountsFirstConnection[] };
}): AccountsFirstDecision {
  if (!input.installationId) return "hide";
  if (input.dismissed.includes(input.installationId)) return "hide";
  if (input.previous !== "pending") return input.previous;
  if (!input.hydrated) return "pending";
  if (input.connections.status === "loading") return "pending";
  // Without shared settings the screen cannot tell what is connected; stay out of the way.
  if (input.connections.status === "error") return "hide";
  return everyProviderConnected(input.connections.connections) ? "hide" : "show";
}
