import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { inspectMaintenanceRecoverySelection } from "./coordinator-bootstrap-maintenance-selection.js";
import { readRetainedMaintenanceRecoveryHistory } from "./coordinator-bootstrap-maintenance-recovery-history.js";

/** Startup may observe a resolved chain, but may not reuse that chain for a
 * fresh claim. A resolution must name this exact independently ready leaf. */
export async function readMaintenanceRecoverySelection(input: {
  plan: unknown;
  account: { uid: number; home: string };
  enrollment: unknown;
  retained: unknown;
  selection: unknown;
  stateDirectory: string;
}) {
  const context = inspectMaintenanceRecoverySelection(input);
  const history = await readRetainedMaintenanceRecoveryHistory({
    ...input,
    signal: AbortSignal.timeout(10_000),
  });
  const { job, reservation } = context;
  const resolved = history.ancestors.filter((ancestor) => ancestor.job.resolvedBy);
  if (resolved.length || job.status === "succeeded") {
    const observation = requireReadyRecoveryLeaf(context);
    const expected = {
      requestId: job.id,
      generation: reservation.generation,
      planSha256: context.planSha256,
      observationSha256: observation.evidenceSha256,
    };
    if (
      resolved.length !== history.ancestors.length ||
      resolved.some((ancestor) => !isDeepStrictEqual(ancestor.job.resolvedBy, expected))
    )
      throw new BootstrapRequestConflict(
        "Recovery startup resolution differs from selected ready leaf",
      );
  }
  history.assertCurrent();
  return context;
}

function requireReadyRecoveryLeaf(context: ReturnType<typeof inspectMaintenanceRecoverySelection>) {
  const { job, reservation, intent, selected } = context;
  const observation = job.observation;
  if (
    job.status !== "succeeded" ||
    !observation ||
    !observation.ready ||
    observation.outcome !== "candidate" ||
    observation.requestId !== job.id ||
    observation.requestRevision !== reservation.requestRevision ||
    observation.generation !== reservation.generation ||
    observation.planSha256 !== context.planSha256 ||
    observation.identitySha256 !== context.identitySha256 ||
    observation.sourceCommit !== selected.sourceCommit ||
    observation.artifactSha256 !== selected.artifactSha256 ||
    Date.parse(observation.observedAt) < Date.parse(intent.consumedAt)
  )
    throw new BootstrapRequestConflict("Recovery startup has no exact ready leaf receipt");
  requireReadyRecoveryRecord(context, observation);
  return observation;
}

function requireReadyRecoveryRecord(
  context: ReturnType<typeof inspectMaintenanceRecoverySelection>,
  observation: NonNullable<
    ReturnType<typeof inspectMaintenanceRecoverySelection>["job"]["observation"]
  >,
) {
  const { job, reservation, selected } = context;
  const records = job.evidence.filter((item) => item.sha256 === observation.evidenceSha256);
  const record = records[0]?.record;
  if (
    records.length !== 1 ||
    !record ||
    createHash("sha256").update(JSON.stringify(record)).digest("hex") !==
      observation.evidenceSha256 ||
    record.requestId !== job.id ||
    record.requestRevision !== reservation.requestRevision ||
    record.planSha256 !== context.planSha256 ||
    record.identitySha256 !== context.identitySha256 ||
    record.observedAt !== observation.observedAt ||
    record.sourceCommit !== selected.sourceCommit ||
    record.artifactSha256 !== selected.artifactSha256 ||
    !record.native.process ||
    record.native.process.bootId !== record.native.bootId ||
    !record.native.service.registered ||
    record.native.selection.sourceCommit !== selected.sourceCommit ||
    record.native.selection.artifactSha256 !== selected.artifactSha256
  )
    throw new BootstrapRequestConflict("Recovery ready leaf lacks retained native evidence");
  requireReadyNativeCustody(record, context);
  return observation;
}

function requireReadyNativeCustody(
  record: ReturnType<
    typeof inspectMaintenanceRecoverySelection
  >["job"]["evidence"][number]["record"],
  context: ReturnType<typeof inspectMaintenanceRecoverySelection>,
) {
  const { selected } = context;
  const native = record.native;
  const identity = context.identity;
  if (
    identity.environment !== "host" ||
    !native.service.launcherSha256 ||
    !native.service.registrationSha256 ||
    !native.selection.receiptSha256 ||
    native.service.domain !== identity.serviceDomain ||
    native.service.label !== identity.serviceLabel ||
    native.service.launcherPath !== identity.launcherPath ||
    native.selection.path !== identity.selectionPath ||
    !native.process ||
    native.process.uid !== identity.custodyOwnerUid ||
    native.process.executable !== selected.node.path
  )
    throw new BootstrapRequestConflict(
      "Recovery ready leaf native custody differs from selected runtime",
    );
}
