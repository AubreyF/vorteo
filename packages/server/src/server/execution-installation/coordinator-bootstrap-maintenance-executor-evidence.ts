import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceExecutorEvidenceSchema,
  MaintenanceServiceEvidenceRecordSchema,
  type MaintenanceServiceJob,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import { readBootstrapLauncher, loadedCoordinatorPid } from "./coordinator-bootstrap-service.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import {
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
  maintenanceUserLauncher,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  retainServiceFiles,
  type MaintenanceServiceInspectionPorts,
} from "./coordinator-bootstrap-maintenance-service-inspection.js";
import type { MaintenanceServiceNativeEvidence } from "./maintenance/service-execution.js";

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

/** Read the actual selected controller, not a constructor-time queue snapshot.
 * Mutable lifecycle bookkeeping is verified by startup but is not execution identity. */
export async function inspectSelectedMaintenanceExecutor(input: {
  setupFile: string;
  account: { uid: number; home: string };
  stateDirectory: string;
  writableMountRoots: readonly string[];
  ports: MaintenanceServiceInspectionPorts;
}) {
  const startup = await readMaintenanceLauncherStartup(input);
  const context = await verifyMaintenanceLauncherArtifacts({
    ...input,
    plan: startup.plan,
  });
  const { identity } = context.plan;
  const selected = startup.selected;
  if (
    identity.environment !== "host" ||
    identity.target !== "maintenance-controller" ||
    !identity.selectionPath ||
    startup.setup.enrollmentStateDirectory !== input.stateDirectory
  )
    throw new BootstrapRequestConflict("Native executor is not the enrolled controller");
  const assertFiles = retainServiceFiles([
    identity.launcherPath,
    identity.selectionPath,
    startup.planFile,
    selected.setup.path,
    selected.node.path,
    selected.entrypoint.path,
  ]);
  const launcher = await readProtectedDocument(identity.launcherPath);
  const selection = await readProtectedDocument(identity.selectionPath);
  const decoded = await readBootstrapLauncher(
    { path: identity.launcherPath, sha256: hash(launcher) },
    input.writableMountRoots,
  );
  if (!isDeepStrictEqual(decoded, maintenanceUserLauncher(startup.plan, startup.selection.slot)))
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
  const executor = MaintenanceServiceExecutorEvidenceSchema.parse({
    target: identity.target,
    identitySha256: context.identitySha256,
    planSha256: context.planSha256,
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
        registrationSha256: hash(JSON.stringify(decoded)),
      },
      selection: {
        path: identity.selectionPath,
        receiptSha256: hash(selection),
        sourceCommit: selected.sourceCommit,
        artifactSha256: selected.artifactSha256,
      },
    },
  });
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
  return { startup, executor, assertCurrent };
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
