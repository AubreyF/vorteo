import path from "node:path";
import { assertMaintenanceRuntimeProcessesAbsent } from "./coordinator-bootstrap-maintenance-process-inventory.js";
import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceEvidenceRecordSchema,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import { verifyMaintenanceLauncherArtifacts } from "./coordinator-bootstrap-maintenance-launcher.js";
import { inspectMaintenanceRecoveryPlan } from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import { inspectNativeMaintenanceRecoveryHistory } from "./coordinator-bootstrap-maintenance-recovery-history.js";
import {
  verifyRecoveryExecutorExit,
  type RecoveryBootWitness,
} from "./coordinator-bootstrap-maintenance-recovery-proof.js";
import { assertMaintenanceServiceAbsent } from "./coordinator-bootstrap-maintenance-absence.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import type { MaintenanceServiceNativeEvidence } from "./maintenance/service-execution.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** An absent service may leave partial selection bytes. Record those exact
 * bytes without calling them a valid selected release. Plans still authorize
 * only the original reviewed slots; this evidence never grants dispatch. */
export async function inspectAbsentMaintenanceRecovery(input: {
  request: unknown;
  plan: unknown;
  account: { uid: number; home: string };
  stateDirectory: string;
  writableMountRoots: readonly string[];
  reader: Parameters<typeof verifyRecoveryExecutorExit>[0]["reader"];
  currentBoot: RecoveryBootWitness;
  childCustody?: Pick<RecoveryBootWitness, "process" | "assertCurrent">;
  coordinatorCustody?: Parameters<typeof assertMaintenanceRuntimeProcessesAbsent>[0]["coordinator"];
  signal: AbortSignal;
  assertAbsent?: (service: string) => void;
  assertRuntimeAbsent?: typeof assertMaintenanceRuntimeProcessesAbsent;
}): Promise<MaintenanceServiceNativeEvidence> {
  input.signal.throwIfAborted();
  const job = MaintenanceServiceJobSchema.parse(input.request);
  const context = inspectMaintenanceRecoveryPlan(input.plan, input.account);
  const { identity, identitySha256, selected } = context;
  if (identity.environment !== "host" || !identity.selectionPath)
    throw new BootstrapRequestConflict("Recovery target lacks native selection custody");
  requireRecoveryProposal(job, context);
  if (input.currentBoot.target === identity.target)
    throw new BootstrapRequestConflict("Absent target cannot be its own live recovery executor");
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const assertAbsent = input.assertAbsent ?? assertMaintenanceServiceAbsent;
  const assertIdentity = () => {
    input.signal.throwIfAborted();
    if (
      !isDeepStrictEqual(
        identity,
        readEnrollmentNativeIdentity(input.stateDirectory, identitySha256),
      )
    )
      throw new BootstrapRequestConflict("Recovery native registration changed");
    if (assertAbsent(service) !== undefined)
      throw new BootstrapRequestConflict("Recovery absence recheck must be synchronous");
  };
  assertIdentity();
  await verifyMaintenanceLauncherArtifacts({ ...input, plan: context.plan.original });
  const slots = [context.plan.original.previous, context.plan.original.candidate].filter(
    (slot) => slot !== null,
  );
  const assertArtifacts = retainServiceFiles(
    slots.flatMap((slot) => [slot.setup.path, slot.node.path, slot.entrypoint.path]),
  );
  const history = await inspectNativeMaintenanceRecoveryHistory({
    ...input,
    currentRequest: job,
  });
  const targetExits: Array<() => void> = [];
  for (const ancestor of history.ancestors) {
    for (const evidence of ancestor.job.evidence) {
      const record = evidence.record;
      if (record.native.process) {
        targetExits.push(
          await verifyRecoveryExecutorExit({
            reader: input.reader,
            expected: record.native.process,
            installationId: identity.installationId,
            currentBoot: input.currentBoot,
          }),
        );
      }
    }
  }
  if (
    input.childCustody &&
    (input.childCustody.process.pid !== process.pid ||
      input.childCustody.process.uid !== input.account.uid ||
      input.childCustody.process.bootId !== input.currentBoot.process.bootId ||
      input.childCustody.assertCurrent() !== undefined)
  )
    throw new BootstrapRequestConflict("Recovery child custody differs from current boot");
  if (
    input.coordinatorCustody &&
    (input.coordinatorCustody.installationId !== identity.installationId ||
      input.coordinatorCustody.process.bootId !== input.currentBoot.process.bootId ||
      input.coordinatorCustody.process.pid === input.currentBoot.process.pid ||
      input.coordinatorCustody.assertCurrent() !== undefined)
  )
    throw new BootstrapRequestConflict(
      "Shared coordinator witness differs from recovery installation",
    );
  const runtimeInput = {
    uid: input.account.uid,
    executables: [...new Set(slots.map((slot) => slot.node.path))],
    coordinator: input.coordinatorCustody,
    allowedProcesses: [input.currentBoot, ...(input.childCustody ? [input.childCustody] : [])],
  };
  const inspectRuntimes = input.assertRuntimeAbsent ?? assertMaintenanceRuntimeProcessesAbsent;
  const assertRuntime = () => {
    if (inspectRuntimes(runtimeInput) !== undefined)
      throw new BootstrapRequestConflict("Runtime absence recheck must be synchronous");
  };
  assertRuntime();
  const launcher = await retainRecoveryStateFile(identity.launcherPath);
  const selection = await retainRecoveryStateFile(identity.selectionPath);
  const record = MaintenanceServiceEvidenceRecordSchema.parse({
    requestId: job.id,
    requestRevision: job.revision,
    planSha256: context.planSha256,
    identitySha256,
    sourceCommit: selected.sourceCommit,
    artifactSha256: selected.artifactSha256,
    observedAt: new Date().toISOString(),
    native: {
      bootId: input.currentBoot.process.bootId,
      process: null,
      service: {
        domain: identity.serviceDomain,
        label: identity.serviceLabel,
        registered: false,
        launcherPath: identity.launcherPath,
        launcherSha256: launcher.sha256,
        registrationSha256: null,
      },
      selection: {
        path: identity.selectionPath,
        receiptSha256: selection.sha256,
        sourceCommit: null,
        artifactSha256: null,
      },
    },
  });
  const assertCurrent = () => {
    history.assertCurrent();
    assertArtifacts();
    for (const assertExit of targetExits) assertExit();
    launcher.assertCurrent();
    selection.assertCurrent();
    assertIdentity();
    assertRuntime();
  };
  assertCurrent();
  return { ...record, evidenceSha256: digest(Buffer.from(JSON.stringify(record))), assertCurrent };
}

async function retainRecoveryStateFile(file: string) {
  let exists = true;
  try {
    lstatSync(file);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    const assertCurrent = retainServiceFiles([file]);
    const bytes = await readProtectedDocument(file);
    assertCurrent();
    return { sha256: digest(bytes), assertCurrent };
  }
  const assertParent = retainServiceFiles([path.dirname(file)]);
  const assertCurrent = () => {
    assertParent();
    try {
      lstatSync(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    throw new BootstrapRequestConflict("Recovery state appeared during native inspection");
  };
  assertCurrent();
  return { sha256: null, assertCurrent };
}

function requireRecoveryProposal(
  job: ReturnType<typeof MaintenanceServiceJobSchema.parse>,
  context: ReturnType<typeof inspectMaintenanceRecoveryPlan>,
) {
  const { identity, identitySha256, selected } = context;
  const operation = context.slot === "candidate" ? "recovery" : "rollback";
  const previousSlot =
    operation === "recovery" ? context.plan.original.previous : context.plan.original.candidate;
  const previous = previousSlot && {
    sourceCommit: previousSlot.sourceCommit,
    artifactSha256: previousSlot.artifactSha256,
  };
  if (
    job.id !== job.proposal.id ||
    job.operation !== operation ||
    job.target !== identity.target ||
    job.proposal.target !== identity.target ||
    job.proposal.operation !== operation ||
    job.proposal.installationId !== identity.installationId ||
    job.proposal.identitySha256 !== identitySha256 ||
    job.proposal.planSha256 !== context.planSha256 ||
    job.proposal.sourceCommit !== selected.sourceCommit ||
    job.proposal.artifactSha256 !== selected.artifactSha256 ||
    !isDeepStrictEqual(job.proposal.recoveryOf, context.plan.recoveryOf) ||
    !isDeepStrictEqual(job.proposal.previous, previous)
  )
    throw new BootstrapRequestConflict("Recovery proposal differs from retained native plan");
}
