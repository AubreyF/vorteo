/**
 * Combined status for a connection that every environment shares. Pure so the
 * wording can be tested without rendering Settings.
 */
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type { ProviderUsage } from "@/provider-usage/types";

export function environmentLabel(environment: InstallationEnvironment) {
  return environment.kind === "host" ? "Host" : "Dev container";
}

export type EnvironmentStateKind =
  | "ready"
  | "excluded"
  | "offline"
  | "attention"
  | "loading"
  | "none";

export interface EnvironmentState {
  environment: InstallationEnvironment;
  kind: EnvironmentStateKind;
  /** Short status shown when this environment differs from the rest. */
  label: string;
  error: string | null;
  usage: ProviderUsage | undefined;
}

export function classifyEnvironment(input: {
  bound: boolean;
  excluded: boolean;
  connected: boolean;
  needsSignIn: boolean;
  entry: { status: string; enabled?: boolean; error?: string | null } | undefined;
  settled: boolean;
}): Pick<EnvironmentState, "kind" | "label" | "error"> {
  const { entry } = input;
  const state = (kind: EnvironmentStateKind, label: string, error: string | null = null) => ({
    kind,
    label,
    error,
  });
  if (!input.bound) return state("none", "Not set up");
  if (input.excluded) return state("excluded", "Off");
  if (!input.connected) return state("offline", "Offline");
  if (input.needsSignIn) return state("attention", "Needs sign-in");
  if (!entry)
    return input.settled ? state("attention", "Not installed") : state("loading", "Checking");
  if (entry.enabled === false) return state("attention", "Disabled");
  if (entry.status === "ready") return state("ready", "Ready");
  if (entry.status === "loading") return state("loading", "Checking");
  return state(
    "attention",
    entry.status === "unavailable" ? "Unavailable" : "Error",
    entry.error ?? null,
  );
}

/** "Ready everywhere", or what differs per environment. */
export function describeConnectionStatus(
  states: readonly Pick<EnvironmentState, "kind" | "label" | "environment">[],
): string {
  const relevant = states.filter((state) => state.kind !== "none");
  if (!relevant.length) return "Not set up yet";
  const included = relevant.filter((state) => state.kind !== "excluded");
  const excluded = relevant.filter((state) => state.kind === "excluded");
  // Environments without this connection, so a Host-only sign-in is visible.
  const missing = states.filter((state) => state.kind === "none");
  const offIn = [
    ...excluded.map((state) => `Off in ${environmentLabel(state.environment)}`),
    ...missing.map((state) => `Not set up in ${environmentLabel(state.environment)}`),
  ];
  if (!included.length) return offIn.join(" · ");
  if (included.every((state) => state.kind === "ready")) {
    let ready = "Ready everywhere";
    if (included.length === 1)
      ready =
        states.length === 1 ? "Ready" : `Ready in ${environmentLabel(included[0]!.environment)}`;
    return [ready, ...offIn].join(" · ");
  }
  if (included.every((state) => state.kind === "loading")) return "Checking";
  const parts = included.map((state) =>
    state.kind === "ready"
      ? `Ready in ${environmentLabel(state.environment)}`
      : `${environmentLabel(state.environment)}: ${state.label}`,
  );
  return [...parts, ...offIn].join(" · ");
}
