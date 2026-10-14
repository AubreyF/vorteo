import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  BootstrapClaimedRecoveryRequestSchema,
  CoordinatorBootstrapRequestSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { assertRecoveredBootstrapBase, BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { validateClaimFence } from "./coordinator-bootstrap-journal.js";
import {
  claimedRecoveryPlanDigest,
  validateClaimedRecoveryPlan,
} from "./coordinator-bootstrap-claimed-recovery.js";
import { terminalBootstrapRelease } from "./coordinator-bootstrap-renewal.js";
import { verifyRetainedProcessExited } from "./coordinator-bootstrap-service.js";

/** Structural history check only. Callers must independently verify protected
 * receipt provenance, native absence and selection under exclusion before
 * admitting a successor. A successful recovery is not a release transfer. */
export function inspectClaimedSuccessorHistory(input: {
  records: unknown;
  recovery: unknown;
  fence: unknown;
  identity: { installationId: string; stateDirectory: string; service: string };
}) {
  const records = z.array(CoordinatorBootstrapRequestSchema).parse(input.records);
  const { recovery, fence } = readSuccessfulHistory(input.recovery, input.fence);

  const index = records.findIndex((record) => record.id === fence.fenced.id);
  if (
    index < 0 ||
    !isDeepStrictEqual(records[index], fence.fenced) ||
    records.filter((record) => record.id === fence.fenced.id).length !== 1 ||
    records.slice(index + 1).some((record) => record.execution)
  )
    throw new BootstrapRequestConflict("Claimed recovery is not the retained unfinished operation");

  // Keep the real terminal release authority. Do not synthesize an executor or
  // transfer receipt for the fenced request, or change its durable status.
  const remaining = records.filter((_, position) => position !== index);
  const terminal = terminalBootstrapRelease(remaining, input.identity);
  if (!terminal || !sameRetainedRelease(terminal.release, fence.original.plan.previous))
    throw new BootstrapRequestConflict("Claimed recovery does not preserve the terminal release");
  const plan = fence.original.plan;
  if (
    plan.recoveredFrom &&
    !isDeepStrictEqual(assertRecoveredBootstrapBase(plan, remaining), terminal.request)
  )
    throw new BootstrapRequestConflict("Claimed recovery does not extend the terminal chain");
  if (
    plan.installationId !== input.identity.installationId ||
    plan.service !== input.identity.service ||
    !isDeepStrictEqual(plan.state, terminal.request.plan.state)
  )
    throw new BootstrapRequestConflict("Claimed recovery installation history changed");

  return {
    terminal,
    recoveredFrom: {
      id: fence.fenced.id,
      revision: fence.fenced.revision,
      generation: fence.fenced.execution!.generation,
      planSha256: fence.fenced.planSha256,
    },
    recovery: {
      id: recovery.id,
      revision: recovery.revision,
      generation: recovery.execution!.generation,
      planSha256: recovery.planSha256,
    },
  };
}

function readSuccessfulHistory(recoveryValue: unknown, fenceValue: unknown) {
  const recovery = BootstrapClaimedRecoveryRequestSchema.parse(recoveryValue);
  const fence = validateClaimFence(fenceValue);
  validateClaimedRecoveryPlan(recovery.plan);
  if (
    recovery.status !== "approved" ||
    !recovery.decisionAt ||
    recovery.execution?.stage !== "succeeded" ||
    recovery.planSha256 !== claimedRecoveryPlanDigest(recovery.plan) ||
    fence.recovery.id !== recovery.id ||
    fence.recovery.generation !== recovery.execution.generation ||
    fence.recovery.planSha256 !== recovery.planSha256 ||
    !isDeepStrictEqual(fence.original, recovery.plan.original)
  )
    throw new BootstrapRequestConflict("Exact successful claimed recovery history required");

  return { recovery, fence };
}

/** Read only canonical, protected records. This function establishes receipt
 * linkage, not process absence; admission must call verifyClaimedSuccessorExit. */
export async function readClaimedSuccessorEvidence(input: {
  records: unknown;
  identity: { installationId: string; stateDirectory: string; service: string };
  roots: readonly string[];
}) {
  const { FileClaimedRecoveryReviewJournal } =
    await import("./coordinator-bootstrap-claimed-journal.js");
  const { readClaimedDispatchObservation, ClaimedRunnerSetupSchema } =
    await import("./coordinator-bootstrap-claimed-launch.js");
  const { assertBootstrapPathsProtected, readBootstrapPreparedFile, readProtectedDocument } =
    await import("./coordinator-bootstrap-artifact.js");
  const { AuditedProcessObservationSchema } = await import("./coordinator-bootstrap-process.js");
  const { createHash } = await import("node:crypto");
  const { default: path } = await import("node:path");
  const records = z.array(CoordinatorBootstrapRequestSchema).parse(input.records);
  const original = records.findLast((record) => record.execution);
  if (original?.execution?.stage !== "recovery_required") return undefined;
  const state = input.identity.stateDirectory;
  await assertBootstrapPathsProtected([state], input.roots);
  const journal = new FileClaimedRecoveryReviewJournal(state);
  const matches = journal
    .readReviews()
    .filter(
      (record) =>
        record.plan.original.id === original.id && record.execution?.stage === "succeeded",
    );
  if (matches.length !== 1)
    throw new BootstrapRequestConflict("Exact terminal claimed recovery receipt is unavailable");
  const recovery = matches[0];
  const pinDocument = async (file: string) => {
    await assertBootstrapPathsProtected([file], input.roots);
    const bytes = await readProtectedDocument(file);
    const pin = { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
    await readBootstrapPreparedFile(pin, input.roots);
    return { pin, value: JSON.parse(bytes.toString("utf8")) };
  };
  const fence = await pinDocument(
    path.join(state, `coordinator-claim-fence-${recovery.execution!.generation}.json`),
  );
  const history = inspectClaimedSuccessorHistory({ ...input, recovery, fence: fence.value });
  await readBootstrapPreparedFile(recovery.plan.original.plan.previous.configuration, input.roots);
  await readBootstrapPreparedFile(recovery.plan.original.plan.previous.launcher, input.roots);
  journal.inspectEffects(recovery);
  const observation = readClaimedDispatchObservation(state, recovery);
  if (observation.state !== "birth_retained")
    throw new BootstrapRequestConflict("Successful claimed recovery birth is unavailable");
  const birth = await pinDocument(
    path.join(
      state,
      `coordinator-claimed-executor-${recovery.id}-${observation.approvedRevision}.json`,
    ),
  );
  const birthValue = z
    .strictObject({
      version: z.literal(1),
      request: BootstrapClaimedRecoveryRequestSchema.pick({
        id: true,
        revision: true,
        planSha256: true,
      }),
      attemptId: z.string().uuid(),
      setup: z.strictObject({
        path: z.string().startsWith("/"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      executor: AuditedProcessObservationSchema,
    })
    .parse(birth.value);
  const setup = ClaimedRunnerSetupSchema.parse(
    JSON.parse((await readBootstrapPreparedFile(birthValue.setup, input.roots)).toString("utf8")),
  );
  if (setup.provisioning) {
    const { verifyProvisionedClaimedRuntime } =
      await import("./coordinator-bootstrap-claimed-provisioning.js");
    await verifyProvisionedClaimedRuntime({
      setup,
      plan: recovery.plan,
      writableMountRoots: input.roots,
      phase: "retained",
    });
  }
  if (
    birthValue.attemptId !== observation.attemptId ||
    !isDeepStrictEqual(birthValue.executor.identity, observation.executor) ||
    !isDeepStrictEqual(birthValue.request, setup.request) ||
    birthValue.setup.path !==
      path.join(
        state,
        `coordinator-claimed-launch-${recovery.id}-${observation.approvedRevision}.json`,
      ) ||
    setup.stateDirectory !== state ||
    !isDeepStrictEqual(setup.original, {
      id: recovery.plan.original.id,
      revision: recovery.plan.original.revision,
      planSha256: recovery.plan.original.planSha256,
    }) ||
    !isDeepStrictEqual(setup.renewal.configuration, recovery.plan.selectedConfiguration) ||
    !isDeepStrictEqual(setup.renewal.terminal, {
      id: history.terminal.request.id,
      revision: history.terminal.request.revision,
      generation: history.terminal.request.execution!.generation,
      planSha256: history.terminal.request.planSha256,
    })
  )
    throw new BootstrapRequestConflict("Successful claimed recovery provenance changed");
  const witness = {
    recovery: history.recovery,
    original: history.recoveredFrom,
    fence: fence.pin,
    birth: birth.pin,
    setup: birthValue.setup,
  };
  journal.inspectEffects(recovery);
  return { ...history, witness, request: recovery, executor: birthValue.executor.identity, setup };
}

/** Require independent absence or stable native proof of a later PID lifetime.
 * Arbitrary identity mismatches never count as exit. No signals are available. */
export async function verifyClaimedSuccessorExit(
  evidence: Pick<
    NonNullable<Awaited<ReturnType<typeof readClaimedSuccessorEvidence>>>,
    "request" | "executor"
  >,
  reader: {
    verifyProcessExited?(pid: number): Promise<void>;
    inspectProcess?(pid: number): Promise<unknown>;
  },
) {
  if (!reader.verifyProcessExited)
    throw new BootstrapRequestConflict("Claimed successor native exit proof is unavailable");
  await verifyRetainedProcessExited(reader, evidence.request.plan.executor.identity);
  await verifyRetainedProcessExited(reader, evidence.executor);
}

function sameRetainedRelease(
  left: z.infer<typeof CoordinatorBootstrapRequestSchema>["plan"]["previous"],
  right: z.infer<typeof CoordinatorBootstrapRequestSchema>["plan"]["previous"],
) {
  // Each maintenance plan retains its own protected copies of configuration
  // and launcher bytes. Those snapshot paths need not be the earlier plan's.
  const identity = ({ configuration, launcher, ...runtime }: typeof left) => ({
    ...runtime,
    configuration: configuration.sha256,
    launcher: launcher.sha256,
  });
  return isDeepStrictEqual(identity(left), identity(right));
}
