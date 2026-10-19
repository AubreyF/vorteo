import type { FactorySnapshot } from "../shared/contracts.js";
import type { FactorySetup } from "../shared/operations.js";

export type FactorySetupObservationState =
  | { kind: "identity_unavailable" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "identity_mismatch" }
  | { kind: "observed"; setup: FactorySetup; retained: boolean };

interface SetupObservationInput {
  hostId: string;
  projectId: string | null;
  setup: FactorySetup | undefined;
  pending: boolean;
  failed: boolean;
  paused: boolean;
}

export function resolveFactorySetupObservation({
  hostId,
  projectId,
  setup,
  pending,
  failed,
  paused,
}: SetupObservationInput): FactorySetupObservationState {
  if (projectId === null) return { kind: "identity_unavailable" };
  if (setup !== undefined) {
    const matches = setup.serverId === hostId && setup.projectId === projectId;
    if (!matches) return { kind: "identity_mismatch" };
    return { kind: "observed", setup, retained: failed || paused };
  }
  if (failed || paused) return { kind: "unavailable" };
  if (pending) return { kind: "loading" };
  return { kind: "unavailable" };
}

export type FactoryDataSource =
  | { kind: "fixture"; snapshot: FactorySnapshot }
  | { kind: "live"; snapshot: FactorySnapshot }
  | { kind: "retained"; snapshot: FactorySnapshot };

export type FactoryObservationState =
  | { kind: "identity_unavailable" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "identity_mismatch" }
  | { kind: "observed"; source: Exclude<FactoryDataSource, { kind: "fixture" }> };

interface ObservationInput {
  hostId: string;
  projectId: string | null;
  snapshot: FactorySnapshot | undefined;
  pending: boolean;
  failed: boolean;
  paused: boolean;
}

/** Cached observations remain useful only within their exact host/project scope. */
export function resolveFactoryObservation({
  hostId,
  projectId,
  snapshot,
  pending,
  failed,
  paused,
}: ObservationInput): FactoryObservationState {
  if (projectId === null) return { kind: "identity_unavailable" };
  if (snapshot !== undefined) {
    const identityMatches = snapshot.serverId === hostId && snapshot.projectId === projectId;
    if (!identityMatches) return { kind: "identity_mismatch" };
    const unavailable = failed || paused;
    const source: Exclude<FactoryDataSource, { kind: "fixture" }> = {
      kind: unavailable ? "retained" : "live",
      snapshot,
    };
    return { kind: "observed", source };
  }
  if (failed || paused) return { kind: "unavailable" };
  if (pending) return { kind: "loading" };
  return { kind: "unavailable" };
}
