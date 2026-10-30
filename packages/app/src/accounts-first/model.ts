import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";

/**
 * True when the owner has connected at least one provider account to the installation.
 *
 * Accounts added through Vorteo carry `accountSetup`; default provider connections do not.
 * A default connection signed in on one environment is local to it, so it does not count as
 * an installation account and the first screen still offers to connect one.
 */
export function hasInstallationAccounts(
  definitions: readonly InstallationProvider[] | undefined,
): boolean {
  return (definitions ?? []).some(
    (definition) => definition.accountSetup !== undefined && definition.removed !== true,
  );
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
  settings:
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; definitions: readonly InstallationProvider[] | undefined };
}): AccountsFirstDecision {
  if (!input.installationId) return "hide";
  if (input.dismissed.includes(input.installationId)) return "hide";
  if (input.previous !== "pending") return input.previous;
  if (!input.hydrated) return "pending";
  if (input.settings.status === "loading") return "pending";
  // Without shared settings the screen cannot tell what is connected; stay out of the way.
  if (input.settings.status === "error") return "hide";
  return hasInstallationAccounts(input.settings.definitions) ? "hide" : "show";
}
