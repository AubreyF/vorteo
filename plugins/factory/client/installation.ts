import {
  FactorySetupSchema,
  FactoryInstallInputSchema,
  FactoryInstallResultSchema,
  type FactorySetup,
  type FactoryInstallInput,
  type FactoryInstallResult,
} from "../shared/operations.js";

interface Scope {
  hostId: string;
  projectId: string;
}

export type FactoryInstallationState =
  | { kind: "idle" }
  | { kind: "checking"; operationId: string }
  | { kind: "dispatching"; operationId: string }
  | {
      kind: "applied";
      operationId: string;
      result: Extract<FactoryInstallResult, { outcome: "applied" }>;
    }
  | { kind: "refused"; operationId: string; reason: string }
  | { kind: "uncertain"; operationId: string; reason: string };

interface InstallationPorts {
  readSetup(): Promise<unknown>;
  install(input: FactoryInstallInput): Promise<unknown>;
  isCurrent(): boolean;
}

export function canInstallFactory(setup: FactorySetup, scope: Scope): boolean {
  return (
    setup.serverId === scope.hostId &&
    setup.projectId === scope.projectId &&
    setup.state === "ready" &&
    setup.operations.install &&
    setup.installationId === null &&
    setup.revision !== null &&
    setup.observedAt !== null
  );
}

export function createFactoryInstallation(inputScope: Scope) {
  const scope = { ...inputScope };
  let state: FactoryInstallationState = Object.freeze({ kind: "idle" });
  const listeners = new Set<() => void>();
  function publish(next: FactoryInstallationState) {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  }
  async function run(setup: FactorySetup, operationId: string, ports: InstallationPorts) {
    if (state.kind !== "idle" && state.kind !== "refused") return;
    // Preserve the displayed precondition and invocation callbacks across asynchronous reads.
    const expectedRevision = setup.revision;
    const { readSetup, install, isCurrent } = ports;
    if (!canInstallFactory(setup, scope) || !isCurrent()) return;
    publish({ kind: "checking", operationId });
    let input: FactoryInstallInput;
    try {
      const fresh = FactorySetupSchema.parse(await readSetup());
      if (!canInstallFactory(fresh, scope) || fresh.revision !== expectedRevision || !isCurrent())
        throw new Error("Factory setup changed before installation.");
      input = FactoryInstallInputSchema.parse({
        projectId: scope.projectId,
        expectedServerId: scope.hostId,
        expectedInstallationId: null,
        expectedRevision,
        operationId,
      });
    } catch {
      publish({
        kind: "refused",
        operationId,
        reason: "Fresh setup could not be verified. No installation was sent. Refresh setup first.",
      });
      return;
    }
    publish({ kind: "dispatching", operationId });
    if (!isCurrent()) {
      publish({
        kind: "refused",
        operationId,
        reason: "Selected host or project changed. No installation was sent.",
      });
      return;
    }
    try {
      const result = FactoryInstallResultSchema.parse(await install(input));
      if (
        result.serverId !== scope.hostId ||
        result.projectId !== scope.projectId ||
        result.operationId !== operationId ||
        !isCurrent()
      )
        throw new Error("Factory installation response identity changed.");
      if (result.outcome === "applied") publish({ kind: "applied", operationId, result });
      else publish({ kind: result.outcome, operationId, reason: result.reason });
    } catch {
      publish({
        kind: "uncertain",
        operationId,
        reason:
          "Installation response unavailable or invalid. Reconcile this operation before another attempt.",
      });
    }
  }
  return {
    run,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// Keep uncertain attempts across panel unmounts. Native persisted checkpoints enforce holds after reload.
const installations = new Map<string, ReturnType<typeof createFactoryInstallation>>();
export function getFactoryInstallation(hostId: string, projectId: string) {
  const key = JSON.stringify([hostId, projectId]);
  let installation = installations.get(key);
  if (!installation) {
    installation = createFactoryInstallation({ hostId, projectId });
    installations.set(key, installation);
  }
  return installation;
}

let operationSequence = 0;
export function createFactoryOperationId(): string {
  // Correlation only, never an authorization or ownership token.
  return `factory-install-${Date.now()}-${++operationSequence}-${Math.random().toString(36).slice(2)}`;
}
