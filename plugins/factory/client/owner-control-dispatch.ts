import type {
  FactoryControlInput,
  FactoryControlResult,
  FactoryControlState,
} from "../shared/operations.js";

interface ControlDispatch {
  hostId: string;
  projectId: string;
  observed: FactoryControlState | undefined;
  action: FactoryControlInput["action"];
  operationId: string;
  assertCurrent(): void;
  read(input: { projectId: string }): Promise<FactoryControlState>;
  execute(input: FactoryControlInput): Promise<FactoryControlResult>;
}

/** One owner action, with a fresh identity check and no transport retry. */
export async function dispatchFactoryControl(
  input: ControlDispatch,
): Promise<FactoryControlResult> {
  const { observed, hostId, projectId, action, operationId } = input;
  input.assertCurrent();
  if (!observed?.revision || !observed.installationId || !observed.operations[action])
    throw new Error("Factory control is unavailable. Refresh its state before trying again.");
  const current = await input.read({ projectId });
  input.assertCurrent();
  if (
    current.serverId !== hostId ||
    current.projectId !== projectId ||
    current.installationId !== observed.installationId ||
    !current.revision ||
    (action === "resume" && current.revision !== observed.revision) ||
    !current.operations[action]
  )
    throw new Error("Factory control changed. Review its current state before acting.");
  // Pause and stop apply to the current work. Resume requires the state the owner reviewed.
  const result = await input.execute({
    projectId,
    expectedServerId: hostId,
    expectedInstallationId: observed.installationId,
    expectedRevision: current.revision,
    operationId,
    action,
  });
  if (
    result.serverId !== hostId ||
    result.projectId !== projectId ||
    result.installationId !== observed.installationId ||
    result.operationId !== operationId
  )
    throw new Error(
      "Factory control response could not be verified. Inspect its retained state before another action.",
    );
  if (result.outcome !== "applied") throw new Error(result.reason);
  return result;
}
