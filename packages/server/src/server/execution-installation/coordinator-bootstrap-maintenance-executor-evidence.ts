import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceExecutorEvidenceSchema,
  MaintenanceServiceEvidenceRecordSchema,
  type MaintenanceServiceJob,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
import { readBootstrapLauncher, loadedCoordinatorPid } from "./coordinator-bootstrap-service.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import {
  inspectMaintenanceLauncherPlan,
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
  maintenanceUserLauncher,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  inspectMaintenanceServiceNative,
  retainServiceFiles,
  type MaintenanceServiceInspectionPorts,
} from "./coordinator-bootstrap-maintenance-service-inspection.js";
import type { MaintenanceServiceNativeEvidence } from "./maintenance/service-execution.js";

import {
  MaintenanceRecoveryPlanSchema,
  inspectMaintenanceRecoveryPlan,
} from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import { inspectSelectedCoordinatorRuntime } from "./coordinator-bootstrap-renewal.js";

import { inspectAbsentMaintenanceRecovery } from "./coordinator-bootstrap-maintenance-recovery-inspection.js";

/** Parent inspection and the one-generation child use the same target proof.
 * This gathers evidence only; locked admission still owns every new effect. */
export async function inspectMaintenanceTargetEvidence(
  input: Parameters<typeof inspectAbsentMaintenanceRecovery>[0] & {
    ports: MaintenanceServiceInspectionPorts;
  },
): Promise<MaintenanceServiceNativeEvidence> {
  input.signal.throwIfAborted();
  const job = MaintenanceServiceJobSchema.parse(input.request);
  const evidence =
    job.operation === "replacement"
      ? await inspectMaintenanceServiceNative({ ...input, request: job })
      : await inspectAbsentMaintenanceRecovery({ ...input, request: job });
  input.signal.throwIfAborted();
  return evidence;
}

/** An enrolled descriptor selects the role; retained history and native
 * inspection independently establish the actual selected coordinator lifetime. */
export async function inspectMaintenanceCoordinatorWitness(input: {
  installationId: string;
  plan: unknown;
  account: { uid: number; home: string };
  stateDirectory: string;
  writableMountRoots: readonly string[];
  ports: MaintenanceServiceInspectionPorts;
}) {
  const journal = new FileEnrollmentJournal(input.stateDirectory);
  const state = journal.read();
  if (state.status !== "enrolled")
    throw new BootstrapRequestConflict("Coordinator runtime witness requires retained enrollment");
  const target = state.grant.manifest.targets.find((entry) => entry.target === "coordinator");
  if (!target) return undefined;
  const identity = readEnrollmentNativeIdentity(input.stateDirectory, target.identitySha256);
  if (
    identity.installationId !== input.installationId ||
    identity.stateDirectory !== input.stateDirectory
  )
    throw new BootstrapRequestConflict(
      "Coordinator runtime witness differs from configured installation",
    );
  const original = MaintenanceRecoveryPlanSchema.safeParse(input.plan).success
    ? inspectMaintenanceRecoveryPlan(input.plan, input.account).plan.original
    : inspectMaintenanceLauncherPlan(input.plan, input.account).plan;
  const executables = [original.previous, original.candidate].flatMap((slot) =>
    slot ? [slot.node.path] : [],
  );
  const witness = await inspectSelectedCoordinatorRuntime({ ...input, identity, executables });
  if (!witness) return undefined;
  return {
    ...witness,
    assertCurrent() {
      if (
        !isDeepStrictEqual(
          identity,
          readEnrollmentNativeIdentity(input.stateDirectory, target.identitySha256),
        )
      )
        throw new BootstrapRequestConflict("Coordinator runtime identity changed");
      const current = journal.readPolicySnapshot();
      if (
        current.status !== "enrolled" ||
        !isDeepStrictEqual(
          target,
          current.grant.manifest.targets.find((entry) => entry.target === "coordinator"),
        )
      )
        throw new BootstrapRequestConflict("Coordinator runtime enrollment binding changed");
      witness.assertCurrent();
    },
  };
}

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Exclude mutable queue outcome/revision while retaining selected authority. */
export function maintenanceExecutorStartupBinding(
  startup: Awaited<ReturnType<typeof readMaintenanceLauncherStartup>>,
) {
  return {
    planSha256: startup.planSha256,
    selected: startup.selected,
    setup: startup.setup,
    selection: startup.selection,
    planFile: startup.planFile,
    intentFile: startup.intentFile,
  };
}

interface SelectedMaintenanceInspection {
  setupFile: string;
  expectedTarget?: "maintenance-controller" | "recovery-launcher";
  account: { uid: number; home: string };
  stateDirectory: string;
  writableMountRoots: readonly string[];
  ports: MaintenanceServiceInspectionPorts;
}

/** Read the explicitly selected executor role, not a constructor-time queue snapshot.
 * Mutable lifecycle bookkeeping is verified by startup but is not execution identity. */
export async function inspectSelectedMaintenanceExecutor(input: SelectedMaintenanceInspection) {
  const setup = MaintenanceLauncherSetupSchema.parse(
    JSON.parse((await readProtectedDocument(input.setupFile)).toString("utf8")),
  );
  // Older page setups provide listener supervision only. New execution support
  // is explicit in the pinned setup and verified reviewed runtime metadata.
  if (
    setup.target === "recovery-launcher" &&
    setup.control?.recoveryAccess &&
    setup.control.recoveryAccess.serviceExecutorVersion !== 1
  )
    throw new BootstrapRequestConflict(
      "Selected recovery access listener does not provide lifecycle execution",
    );
  const current = await inspectSelectedMaintenanceRole(input);
  const executor = MaintenanceServiceExecutorEvidenceSchema.parse(current.evidence);
  return { startup: current.startup, executor, assertCurrent: current.assertCurrent };
}

/** A selected listener can own a review without becoming an effect executor.
 * Keep this result separate from addressed lifecycle executor evidence. */
export async function inspectSelectedMaintenanceRecoveryAccess(
  input: Omit<SelectedMaintenanceInspection, "expectedTarget">,
) {
  const current = await inspectSelectedMaintenanceRole({
    ...input,
    expectedTarget: "recovery-launcher",
  });
  const access = current.startup.setup.control?.recoveryAccess;
  if (!access)
    throw new BootstrapRequestConflict("Selected recovery launcher has no independent review page");
  return {
    startup: current.startup,
    process: current.evidence.native.process,
    access,
    assertCurrent: current.assertCurrent,
  };
}

async function inspectSelectedMaintenanceRole(input: SelectedMaintenanceInspection) {
  const startup = await readMaintenanceLauncherStartup(input);
  const context = await verifyMaintenanceLauncherArtifacts({
    ...input,
    plan: startup.plan,
  });
  const { identity } = context.plan;
  const selected = startup.selected;
  if (
    identity.environment !== "host" ||
    identity.target !== (input.expectedTarget ?? "maintenance-controller") ||
    !identity.selectionPath ||
    startup.setup.enrollmentStateDirectory !== input.stateDirectory
  )
    throw new BootstrapRequestConflict("Native executor differs from the required enrolled role");
  const assertFiles = retainServiceFiles([
    identity.launcherPath,
    identity.selectionPath,
    startup.planFile,
    selected.setup.path,
    selected.node.path,
    selected.entrypoint.path,
    ...(startup.setup.control?.recoveryAccess?.serviceExecutorVersion === 1
      ? [path.join(selected.directory, "packages/server/package.json")]
      : []),
  ]);
  const launcher = await readProtectedDocument(identity.launcherPath);
  const selection = await readProtectedDocument(identity.selectionPath);
  const decoded = await readBootstrapLauncher(
    { path: identity.launcherPath, sha256: hash(launcher) },
    input.writableMountRoots,
  );
  const expectedLauncher = maintenanceUserLauncher(startup.plan, startup.selection.slot);
  if (!isDeepStrictEqual(decoded, expectedLauncher))
    throw new BootstrapRequestConflict("Executor launcher differs from selected slot");
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const pid = loadedCoordinatorPid(service, await input.ports.reader.readService(service));
  const process = await verifyMaintenanceLauncherProcess({
    plan: startup.plan,
    account: input.account,
    selected: startup.selection.slot,
    pid,
    reader: input.ports.reader,
  });
  if (
    !isDeepStrictEqual(
      maintenanceExecutorStartupBinding(startup),
      maintenanceExecutorStartupBinding(await readMaintenanceLauncherStartup(input)),
    )
  )
    throw new BootstrapRequestConflict("Executor selection changed during native inspection");
  const evidence = {
    target: identity.target,
    identitySha256: context.identitySha256,
    planSha256: startup.planSha256,
    sourceCommit: selected.sourceCommit,
    artifactSha256: selected.artifactSha256,
    runtimeDirectory: selected.directory,
    setup: selected.setup,
    node: selected.node,
    entrypoint: selected.entrypoint,
    native: {
      bootId: process.bootId,
      process,
      service: {
        domain: identity.serviceDomain,
        label: identity.serviceLabel,
        registered: true,
        launcherPath: identity.launcherPath,
        launcherSha256: hash(launcher),
        registrationSha256: hash(JSON.stringify(expectedLauncher)),
      },
      selection: {
        path: identity.selectionPath,
        receiptSha256: hash(selection),
        sourceCommit: selected.sourceCommit,
        artifactSha256: selected.artifactSha256,
      },
    },
  };
  const assertCurrent = () => {
    assertFiles();
    if (
      !isDeepStrictEqual(
        identity,
        readEnrollmentNativeIdentity(input.stateDirectory, context.identitySha256),
      ) ||
      input.ports.assertCurrent(service, process) !== undefined
    )
      throw new BootstrapRequestConflict("Executor native custody changed before admission");
  };
  assertCurrent();
  return { startup, evidence, assertCurrent };
}

export function bindMaintenanceExecutorEvidence(
  target: MaintenanceServiceNativeEvidence,
  current: Awaited<ReturnType<typeof inspectSelectedMaintenanceExecutor>>,
): MaintenanceServiceNativeEvidence {
  const { evidenceSha256: _hash, assertCurrent: assertTarget, ...record } = target;
  if (record.native.bootId !== current.executor.native.bootId)
    throw new BootstrapRequestConflict("Target and executor boot identities differ");
  const bound = MaintenanceServiceEvidenceRecordSchema.parse({
    ...record,
    executor: current.executor,
  });
  const assertCurrent = () => {
    assertTarget();
    current.assertCurrent();
  };
  assertCurrent();
  return {
    ...bound,
    evidenceSha256: hash(JSON.stringify(bound)),
    assertCurrent,
  };
}

/** Reservation addresses the complete retained proof. No runtime substitution
 * is permitted after reservation, including an otherwise compatible new slot. */
export function requireReservedMaintenanceExecutor(job: MaintenanceServiceJob, executor: unknown) {
  const matches = job.evidence.filter(
    (item) => item.sha256 === job.reservation?.nativeEvidenceSha256,
  );
  const retained = matches[0];
  if (
    matches.length !== 1 ||
    !retained ||
    hash(JSON.stringify(retained.record)) !== retained.sha256 ||
    !retained.record.executor ||
    !isDeepStrictEqual(retained.record.executor, executor)
  )
    throw new BootstrapRequestConflict("Selected executor differs from reserved native evidence");
}

/** Boot proof comes from selected native executor inspection, not a caller's
 * serialized boot identifier. Keep its protected custody assertion attached. */
export function maintenanceRecoveryBootWitness(
  current: Awaited<ReturnType<typeof inspectSelectedMaintenanceExecutor>>,
) {
  current.assertCurrent();
  return {
    target: current.executor.target,
    installationId: current.startup.plan.identity.installationId,
    process: current.executor.native.process,
    assertCurrent: current.assertCurrent,
  };
}
