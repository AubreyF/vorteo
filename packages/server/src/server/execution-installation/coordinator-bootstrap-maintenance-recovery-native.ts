import path from "node:path";
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
import type { MaintenanceServiceNativeObservation } from "./maintenance/service-execution.js";
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
  const requireClaim = () => {
    if (!isDeepStrictEqual(readJob(), claimed))
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
  await requireExecutor();
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
  });
  requireClaim();
  await command.run(["bootstrap", identity.serviceDomain, identity.launcherPath]);
  const result = await readBoundedCandidateObservation(input.readCandidateObservation);
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
  },
): Promise<MaintenanceServiceNativeObservation> {
  return readBoundedCandidateObservation(async (signal) => {
    const journal = new FileBootstrapRequestJournal(input.stateDirectory);
    const readJob = () => journal.readLifecycle().find((job) => job.id === input.requestId);
    const retained = readJob();
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
