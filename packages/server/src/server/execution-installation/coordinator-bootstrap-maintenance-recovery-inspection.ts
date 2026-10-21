import path from "node:path";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { inspectRetainedMaintenanceServiceEffect } from "./coordinator-bootstrap-maintenance-service-binding.js";
import { inspectRetainedMaintenanceRecoveryEffect } from "./coordinator-bootstrap-maintenance-recovery-binding.js";
import type { MaintenanceServiceJob } from "@getpaseo/protocol/maintenance-service";
import type { MaintenanceServiceNativeObservation } from "./maintenance/service-execution.js";
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
export interface MaintenanceAbsenceInspectionInput {
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
}

type AbsenceCollectionContext = Pick<
  ReturnType<typeof inspectMaintenanceRecoveryPlan>,
  "identitySha256" | "planSha256" | "selected"
> & {
  original: ReturnType<typeof inspectMaintenanceRecoveryPlan>["plan"]["original"];
  job: MaintenanceServiceJob;
};
interface AbsenceHistory {
  jobs: readonly MaintenanceServiceJob[];
  assertCurrent(): void;
}

export async function inspectAbsentMaintenanceRecovery(
  input: MaintenanceAbsenceInspectionInput,
): Promise<MaintenanceServiceNativeEvidence> {
  input.signal.throwIfAborted();
  const job = MaintenanceServiceJobSchema.parse(input.request);
  const context = inspectMaintenanceRecoveryPlan(input.plan, input.account);
  requireRecoveryProposal(job, context);
  return collectMaintenanceTargetAbsence(
    input,
    { ...context, original: context.plan.original, job },
    async () => {
      const history = await inspectNativeMaintenanceRecoveryHistory({
        ...input,
        currentRequest: job,
      });
      return {
        jobs: history.ancestors.map((ancestor) => ancestor.job),
        assertCurrent: history.assertCurrent,
      };
    },
  );
}

/** Absence is an observation of one consumed generation, never a new claim or
 * a terminal fence. A successor still needs fresh admission and native proof. */
export async function observeConsumedMaintenanceServiceAbsence(
  input: MaintenanceAbsenceInspectionInput,
): Promise<MaintenanceServiceNativeObservation> {
  const job = MaintenanceServiceJobSchema.parse(input.request);
  const context =
    job.operation === "replacement"
      ? inspectRetainedMaintenanceServiceEffect({ ...input, retained: job })
      : inspectRetainedMaintenanceRecoveryEffect({ ...input, retained: job });
  const original = "original" in context.plan ? context.plan.original : context.plan;
  if (original.identity.stateDirectory !== input.stateDirectory)
    throw new BootstrapRequestConflict("Consumed absence differs from configured installation");
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  const assertRetained = () => {
    input.signal.throwIfAborted();
    if (
      !isDeepStrictEqual(
        job,
        journal.readLifecycle().find((value) => value.id === job.id),
      )
    )
      throw new BootstrapRequestConflict("Consumed absence generation changed");
  };
  assertRetained();
  const assertExecutorExit = await verifyRecoveryExecutorExit({
    reader: input.reader,
    expected: context.intent.executor,
    installationId: original.identity.installationId,
    currentBoot: input.currentBoot,
  });
  const selected = "selected" in context ? context.selected : context.plan.candidate;
  const evidence = await collectMaintenanceTargetAbsence(
    { ...input, childCustody: undefined },
    {
      job,
      original,
      selected,
      identitySha256: context.identitySha256,
      planSha256: context.planSha256,
    },
    async () => {
      if (job.operation === "replacement") return { jobs: [job], assertCurrent: assertRetained };
      const history = await inspectNativeMaintenanceRecoveryHistory({
        ...input,
        currentRequest: job,
      });
      return {
        jobs: [job, ...history.ancestors.map((ancestor) => ancestor.job)],
        assertCurrent() {
          history.assertCurrent();
          assertRetained();
        },
      };
    },
  );
  const {
    evidenceSha256: collectedDigest,
    assertCurrent: assertAbsence,
    ...collectedRecord
  } = evidence;
  if (digest(Buffer.from(JSON.stringify(collectedRecord))) !== collectedDigest)
    throw new BootstrapRequestConflict("Consumed absence evidence digest changed");
  const record = MaintenanceServiceEvidenceRecordSchema.parse({
    ...collectedRecord,
    requestRevision: context.reservation.requestRevision,
    sourceCommit: null,
    artifactSha256: null,
  });
  if (Date.parse(record.observedAt) < Date.parse(context.intent.consumedAt))
    throw new BootstrapRequestConflict("Consumed absence predates its intent");
  const assertCurrent = () => {
    assertExecutorExit();
    assertRetained();
    assertAbsence();
  };
  assertCurrent();
  return {
    requestId: job.id,
    requestRevision: context.reservation.requestRevision,
    generation: context.reservation.generation,
    planSha256: context.planSha256,
    identitySha256: context.identitySha256,
    outcome: "unknown",
    ready: false,
    sourceCommit: null,
    artifactSha256: null,
    observedAt: record.observedAt,
    evidenceSha256: digest(Buffer.from(JSON.stringify(record))),
    record,
    assertCurrent,
  };
}

async function collectMaintenanceTargetAbsence(
  input: MaintenanceAbsenceInspectionInput,
  context: AbsenceCollectionContext,
  inspectHistory: () => Promise<AbsenceHistory>,
): Promise<MaintenanceServiceNativeEvidence> {
  input.signal.throwIfAborted();
  const { job, identitySha256, selected } = context;
  const identity = context.original.identity;

  if (identity.environment !== "host" || !identity.selectionPath)
    throw new BootstrapRequestConflict("Recovery target lacks native selection custody");
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
  const slots = [context.original.previous, context.original.candidate].filter(
    (slot) => slot !== null,
  );
  const assertArtifacts = retainServiceFiles(
    slots.flatMap((slot) => [slot.setup.path, slot.node.path, slot.entrypoint.path]),
  );
  await verifyMaintenanceLauncherArtifacts({ ...input, plan: context.original });
  assertArtifacts();
  const history = await inspectHistory();
  const targetExits: Array<() => void> = [];
  for (const ancestor of history.jobs) {
    for (const evidence of ancestor.evidence) {
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
