import { maintenanceServiceCustodyBinding } from "./coordinator-bootstrap-maintenance-service-binding.js";
import { verifyUnclaimedMaintenanceExecutor } from "./coordinator-bootstrap-maintenance-runner-contract.js";
import path from "node:path";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceEvidenceRecordSchema,
} from "@getpaseo/protocol/maintenance-service";
import { assertUnclaimedMaintenanceServiceAbsent } from "./maintenance/service-recovery.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { claimMaintenanceServiceEffect } from "./coordinator-bootstrap-maintenance-service-claim.js";
import {
  inspectMaintenanceRecoveryExecution,
  inspectRetainedMaintenanceRecoveryEffect,
} from "./coordinator-bootstrap-maintenance-recovery-binding.js";
import { inspectAbsentMaintenanceRecovery } from "./coordinator-bootstrap-maintenance-recovery-inspection.js";
import { assertMaintenanceServiceAbsent } from "./coordinator-bootstrap-maintenance-absence.js";
import { assertMaintenanceRuntimeProcessesAbsent } from "./coordinator-bootstrap-maintenance-process-inventory.js";
import {
  renderMaintenanceUserLauncher,
  verifyMaintenanceLauncherArtifacts,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { selectMaintenanceFiles } from "./coordinator-bootstrap-maintenance-file-selection.js";
import {
  readBoundedCandidateObservation,
  readBoundedMaintenanceInspection,
} from "./coordinator-bootstrap-maintenance-service-native.js";
import {
  verifyMaintenanceRecoveryReady,
  verifyMaintenanceRecoveryObservation,
} from "./coordinator-bootstrap-maintenance-recovery-ready.js";
import type {
  MaintenanceServiceNativeObservation,
  MaintenanceServiceNativeEvidence,
} from "./maintenance/service-execution.js";
import {
  verifyRetainedProcessExited,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";

type Claim = Parameters<typeof claimMaintenanceServiceEffect>[0];
type Absence = Parameters<typeof inspectAbsentMaintenanceRecovery>[0];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const nativeCommand = {
  async run(args: readonly string[]) {
    await promisify(execFile)("/bin/launchctl", [...args], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10_000,
      maxBuffer: 8192,
    });
  },
};

/** Execute one newly reserved repair of a proven absent target. A registered or
 * unaccounted process is refused, never stopped by this path. The existing queue
 * owns the proposal and result; any interrupted effect is observation-only. */
export async function executeAbsentMaintenanceRecovery(
  input: Claim & {
    reader: NativeBootstrapServiceReader;
    writableMountRoots: readonly string[];
    currentBoot: Absence["currentBoot"];
    childCustody: NonNullable<Absence["childCustody"]>;
    coordinatorCustody?: Absence["coordinatorCustody"];
    requireExecutor(): Promise<unknown>;
    readCandidateObservation(signal: AbortSignal): Promise<MaintenanceServiceNativeObservation>;
    assertAbsent?: Absence["assertAbsent"];
    assertRuntimeAbsent?: Absence["assertRuntimeAbsent"];
  },
  command: { run(args: readonly string[]): Promise<void> } = nativeCommand,
): Promise<MaintenanceServiceNativeObservation> {
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  const readJob = () => journal.readLifecycle().find((job) => job.id === input.requestId);
  const context = inspectMaintenanceRecoveryExecution({ ...input, retained: readJob() });
  const { identity } = context;
  if (identity.environment !== "host" || !identity.selectionPath)
    throw new BootstrapRequestConflict("Native recovery requires enrolled Host selection");
  const requireExecutor = async () => {
    const actual = BootstrapProcessIdentitySchema.parse(await input.requireExecutor());
    if (
      actual.pid !== process.pid ||
      actual.uid !== process.getuid?.() ||
      !isDeepStrictEqual(actual, input.executor) ||
      !isDeepStrictEqual(actual, input.childCustody.process) ||
      input.childCustody.assertCurrent() !== undefined
    )
      throw new BootstrapRequestConflict("Recovery executor native custody changed");
  };
  const inspectAbsence = () =>
    readBoundedMaintenanceInspection(
      (signal) =>
        inspectAbsentMaintenanceRecovery({
          ...input,
          request: readJob(),
          signal,
        }),
      { timeoutMs: 10_000, detail: "Recovery absence inspection timed out" },
    );
  await requireExecutor();
  const before = await inspectAbsence();
  if (!isDeepStrictEqual(before.native, input.evidence.native))
    throw new BootstrapRequestConflict("Recovery absence differs from admitted evidence");
  before.assertCurrent();
  // The shared admission callback rechecks grant and exclusion while this exact
  // generation consumes its single durable intent. No native work holds the lock.
  const claimed = claimMaintenanceServiceEffect(input);
  process.stderr.write("Maintenance recovery intent consumed.\n");
  const requireClaim = () => {
    if (
      !isDeepStrictEqual(
        maintenanceServiceCustodyBinding(MaintenanceServiceJobSchema.parse(readJob())),
        maintenanceServiceCustodyBinding(claimed),
      )
    )
      throw new BootstrapRequestConflict("Recovery effect ownership changed");
  };
  await requireExecutor();
  const absent = await inspectAbsence();
  requireClaim();
  const selection = {
    version: 3,
    operation: context.job.operation,
    requestId: claimed.id,
    requestRevision: input.reservation.requestRevision,
    intentId: claimed.effectIntent!.id,
    generation: input.reservation.generation,
    planSha256: context.planSha256,
    slot: context.slot,
  };
  journal.withRecoveryTransaction(() => {
    requireClaim();
    absent.assertCurrent();
    selectMaintenanceFiles({
      attemptFile: path.join(
        input.stateDirectory,
        `maintenance-selection-${claimed.effectIntent!.id}.json`,
      ),
      reservationSha256: hash(JSON.stringify(input.reservation)),
      launcher: {
        path: identity.launcherPath,
        previousSha256: absent.native.service.launcherSha256,
        bytes: renderMaintenanceUserLauncher(context.plan.original, context.slot),
      },
      selection: {
        path: identity.selectionPath!,
        previousSha256: absent.native.selection.receiptSha256,
        bytes: Buffer.from(JSON.stringify(selection)),
      },
      assertCurrent: requireClaim,
    });
  });
  process.stderr.write("Maintenance recovery selection published.\n");
  await requireExecutor();
  process.stderr.write("Maintenance recovery selected executor reverified.\n");
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  (input.assertAbsent ?? assertMaintenanceServiceAbsent)(service);
  (input.assertRuntimeAbsent ?? assertMaintenanceRuntimeProcessesAbsent)({
    uid: input.account.uid,
    executables: [
      ...new Set(
        [context.plan.original.previous, context.plan.original.candidate].flatMap((slot) =>
          slot ? [slot.node.path] : [],
        ),
      ),
    ],
    allowedProcesses: [input.currentBoot, input.childCustody],
    coordinator: input.coordinatorCustody,
  });
  requireClaim();
  process.stderr.write("Maintenance recovery native bootstrap started.\n");
  await command.run(["bootstrap", identity.serviceDomain, identity.launcherPath]);
  process.stderr.write("Maintenance recovery native bootstrap returned.\n");
  const result = await readBoundedCandidateObservation(input.readCandidateObservation);
  process.stderr.write("Maintenance recovery candidate observation collected.\n");
  await requireExecutor();
  if (result.record.native.bootId !== input.childCustody.process.bootId)
    throw new BootstrapRequestConflict("Recovery candidate belongs to another native boot");
  const assertReady = await verifyMaintenanceRecoveryReady({
    ...input,
    retained: readJob(),
    result,
  });
  requireClaim();
  return {
    ...result,
    assertCurrent: () => {
      assertReady();
      requireClaim();
    },
  };
}

/** Reopening consumes no authority and performs no effects. A lost start reply
 * or revoked grant cannot erase observation of an already consumed generation. */
export async function observeMaintenanceRecovery(
  input: Pick<Claim, "stateDirectory" | "requestId" | "reservation" | "plan" | "account"> & {
    reader: NativeBootstrapServiceReader;
    writableMountRoots: readonly string[];
    readObservation(signal: AbortSignal): Promise<MaintenanceServiceNativeObservation>;
    readUnclaimedEvidence?(signal: AbortSignal): Promise<MaintenanceServiceNativeEvidence>;
  },
): Promise<MaintenanceServiceNativeObservation> {
  return readBoundedCandidateObservation(async (signal) => {
    const journal = new FileBootstrapRequestJournal(input.stateDirectory);
    const readJob = () => journal.readLifecycle().find((job) => job.id === input.requestId);
    const retained = readJob();
    const job = MaintenanceServiceJobSchema.parse(retained);
    if (!job.effectIntent) {
      const unclaimed = inspectMaintenanceRecoveryExecution({ ...input, retained });
      if (
        unclaimed.identity.stateDirectory !== input.stateDirectory ||
        !input.readUnclaimedEvidence
      )
        throw new BootstrapRequestConflict("Unclaimed recovery absence inspection is unavailable");
      const reservedContract = await verifyUnclaimedMaintenanceExecutor({ ...input, job, signal });
      const {
        evidenceSha256: admissionSha256,
        assertCurrent: assertAbsent,
        ...admissionRecord
      } = await input.readUnclaimedEvidence(signal);
      signal.throwIfAborted();
      const identity = unclaimed.identity;
      if (
        hash(JSON.stringify(admissionRecord)) !== admissionSha256 ||
        admissionRecord.requestRevision !== job.revision ||
        admissionRecord.sourceCommit !== unclaimed.selected.sourceCommit ||
        admissionRecord.artifactSha256 !== unclaimed.selected.artifactSha256 ||
        identity.environment !== "host" ||
        admissionRecord.native.service.domain !== identity.serviceDomain ||
        admissionRecord.native.service.label !== identity.serviceLabel ||
        admissionRecord.native.service.launcherPath !== identity.launcherPath ||
        admissionRecord.native.selection.path !== identity.selectionPath
      )
        throw new BootstrapRequestConflict(
          "Unclaimed recovery absence differs from its current native target",
        );
      const record = MaintenanceServiceEvidenceRecordSchema.parse({
        ...admissionRecord,
        requestRevision: unclaimed.reservation.requestRevision,
        sourceCommit: null,
        artifactSha256: null,
      });
      const evidenceSha256 = hash(JSON.stringify(record));
      const observation = {
        requestId: job.id,
        requestRevision: unclaimed.reservation.requestRevision,
        generation: unclaimed.reservation.generation,
        planSha256: unclaimed.planSha256,
        identitySha256: unclaimed.identitySha256,
        outcome: "unknown" as const,
        ready: false,
        sourceCommit: null,
        artifactSha256: null,
        observedAt: record.observedAt,
        evidenceSha256,
      };
      const evidence = job.evidence.some((item) => item.sha256 === evidenceSha256)
        ? job.evidence
        : [...job.evidence, { sha256: evidenceSha256, record }];
      // Validate the proposed terminal state; only the queue's locked write can
      // persist it and fence a child that has not consumed its effect intent.
      assertUnclaimedMaintenanceServiceAbsent({ ...job, status: "failed", evidence, observation });
      const assertCurrent = () => {
        signal.throwIfAborted();
        assertAbsent();
        reservedContract.assertCurrent();
        if (!isDeepStrictEqual(retained, readJob()))
          throw new BootstrapRequestConflict("Unclaimed recovery changed before terminal fencing");
      };
      assertCurrent();
      return { ...observation, record, unclaimedAbsent: true, assertCurrent };
    }
    const context = inspectRetainedMaintenanceRecoveryEffect({ ...input, retained });
    if (
      context.identity.stateDirectory !== input.stateDirectory ||
      !isDeepStrictEqual(context.reservation, input.reservation)
    )
      throw new BootstrapRequestConflict("Recovery observation reservation changed");
    // Artifact readers hold native file references. Wait for the exact effect
    // executor to exit so observation cannot invalidate its absence inventory.
    await verifyRetainedProcessExited(input.reader, context.intent.executor);
    signal.throwIfAborted();
    await verifyMaintenanceLauncherArtifacts({ ...input, plan: context.plan.original });
    signal.throwIfAborted();
    const result = await input.readObservation(signal);
    signal.throwIfAborted();
    const assertObservation = await verifyMaintenanceRecoveryObservation({
      ...input,
      retained,
      result,
    });
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertObservation();
      if (!isDeepStrictEqual(retained, readJob()))
        throw new BootstrapRequestConflict("Retained recovery observation changed");
    };
    assertCurrent();
    return { ...result, assertCurrent };
  });
}
