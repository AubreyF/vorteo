import { inspectRetainedMaintenanceServiceEffect } from "./coordinator-bootstrap-maintenance-service-binding.js";
import { inspectRetainedMaintenanceRecoveryEffect } from "./coordinator-bootstrap-maintenance-recovery-binding.js";
import {
  MaintenanceLauncherSelectionSchema,
  MaintenanceServiceSelectionSchema,
  MaintenanceRecoverySelectionSchema,
} from "./coordinator-bootstrap-maintenance-selection.js";
import { readRegisteredMaintenanceRuntimeReadiness } from "./coordinator-bootstrap-maintenance-service-status.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import type { MaintenanceServiceNativeObservation } from "./maintenance/service-execution.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceEvidenceRecordSchema,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import {
  createNativeBootstrapServiceReader,
  loadedCoordinatorPid,
  verifyRetainedProcessExited,
  readBootstrapLauncher,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import {
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
  maintenanceUserLauncher,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import type { MaintenanceServiceNativeEvidence } from "./maintenance/service-execution.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
type ProcessIdentity = ReturnType<typeof BootstrapProcessIdentitySchema.parse>;
export interface MaintenanceServiceInspectionPorts {
  reader: NativeBootstrapServiceReader;
  /** A bounded synchronous native recheck for the shared-lock admission. */
  assertCurrent(service: string, process: ProcessIdentity): void;
}

/** The helper buffer is independently pinned before it enters a synchronous
 * recheck. No caller argument selects commands, interpreter or helper source. */
export async function createMaintenanceServiceInspectionPorts(input: {
  helperPath: string;
  helperSha256: string;
  writableMountRoots: readonly string[];
}): Promise<MaintenanceServiceInspectionPorts> {
  const reader = await createNativeBootstrapServiceReader(input);
  const source = (
    await readBootstrapPreparedFile(
      { path: input.helperPath, sha256: input.helperSha256 },
      input.writableMountRoots,
    )
  ).toString("utf8");
  return {
    reader,
    assertCurrent(service, expected) {
      if (
        !/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+\.installation(?:-recovery-[a-f0-9-]{36})?$/.test(
          service,
        ) ||
        !service.startsWith(`gui/${process.getuid?.()}/`)
      )
        throw new BootstrapRequestConflict("Native service recheck target is invalid");
      const options = {
        env: { PATH: "/usr/bin:/bin" },
        timeout: 2000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8" as const,
      };
      try {
        const pid = loadedCoordinatorPid(
          service,
          execFileSync("/bin/launchctl", ["print", service], options),
        );
        if (pid !== expected.pid) throw new Error("Different service process");
        const current = BootstrapProcessIdentitySchema.parse(
          JSON.parse(
            execFileSync("/usr/bin/python3", ["-I", "-B", "-c", source, String(pid)], options),
          ),
        );
        if (!isDeepStrictEqual(current, expected)) throw new Error("Different process lifetime");
      } catch {
        throw new BootstrapRequestConflict("Native service custody changed before admission");
      }
    },
  };
}

/** Produces admission evidence only. Candidate bytes are verified separately
 * from the currently selected previous process; neither proves readiness. */
export async function inspectMaintenanceServiceNative(input: {
  request: unknown;
  plan: unknown;
  account: { uid: number; home: string };
  stateDirectory: string;
  writableMountRoots: readonly string[];
  ports: MaintenanceServiceInspectionPorts;
}): Promise<MaintenanceServiceNativeEvidence> {
  const job = MaintenanceServiceJobSchema.parse(input.request);
  const context = await verifyMaintenanceLauncherArtifacts(input);
  const { plan, identitySha256, planSha256 } = context;
  const identity = plan.identity;
  if (identity.environment !== "host" || !identity.selectionPath || !plan.previous)
    throw new BootstrapRequestConflict(
      "Service admission requires a retained previous native slot",
    );
  if (
    job.target !== identity.target ||
    job.proposal.installationId !== identity.installationId ||
    job.proposal.planSha256 !== planSha256 ||
    job.proposal.identitySha256 !== identitySha256 ||
    job.proposal.sourceCommit !== plan.candidate.sourceCommit ||
    job.proposal.artifactSha256 !== plan.candidate.artifactSha256 ||
    !isDeepStrictEqual(job.proposal.previous, {
      sourceCommit: plan.previous.sourceCommit,
      artifactSha256: plan.previous.artifactSha256,
    })
  )
    throw new BootstrapRequestConflict("Native service proposal differs from prepared artifacts");
  if (
    !isDeepStrictEqual(identity, readEnrollmentNativeIdentity(input.stateDirectory, identitySha256))
  )
    throw new BootstrapRequestConflict(
      "Native service registration differs from enrolled identity",
    );
  const files = [
    identity.launcherPath,
    identity.selectionPath,
    plan.previous.setup.path,
    plan.candidate.setup.path,
    plan.previous.node.path,
    plan.candidate.node.path,
    plan.previous.entrypoint.path,
    plan.candidate.entrypoint.path,
  ];
  const assertFiles = retainServiceFiles(files);
  const startup = await readMaintenanceLauncherStartup({
    setupFile: plan.previous.setup.path,
    account: input.account,
  });
  if (
    !isDeepStrictEqual(startup.selected, plan.previous) ||
    !isDeepStrictEqual(startup.plan.identity, identity)
  )
    throw new BootstrapRequestConflict("Service admission previous selection changed");
  const launcher = await readProtectedDocument(identity.launcherPath);
  const selection = await readProtectedDocument(identity.selectionPath);
  const decoded = await readBootstrapLauncher(
    { path: identity.launcherPath, sha256: hash(launcher) },
    input.writableMountRoots,
  );
  const expectedLauncher = maintenanceUserLauncher(plan, "previous");
  if (!isDeepStrictEqual(decoded, expectedLauncher))
    throw new BootstrapRequestConflict(
      "Native service registration differs from previous launcher",
    );
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const pid = loadedCoordinatorPid(service, await input.ports.reader.readService(service));
  const process = await verifyMaintenanceLauncherProcess({
    plan,
    account: input.account,
    selected: "previous",
    pid,
    reader: input.ports.reader,
  });
  const record = MaintenanceServiceEvidenceRecordSchema.parse({
    requestId: job.id,
    requestRevision: job.revision,
    planSha256,
    identitySha256,
    sourceCommit: plan.candidate.sourceCommit,
    artifactSha256: plan.candidate.artifactSha256,
    observedAt: new Date().toISOString(),
    native: {
      bootId: process.bootId,
      process,
      service: {
        domain: identity.serviceDomain,
        label: identity.serviceLabel,
        registered: true,
        launcherPath: identity.launcherPath,
        launcherSha256: hash(launcher),
        // plutil dictionary order is not the reviewed registration's field order.
        registrationSha256: hash(JSON.stringify(expectedLauncher)),
      },
      selection: {
        path: identity.selectionPath,
        receiptSha256: hash(selection),
        sourceCommit: plan.previous.sourceCommit,
        artifactSha256: plan.previous.artifactSha256,
      },
    },
  });
  const assertCurrent = () => {
    assertFiles();
    if (
      !isDeepStrictEqual(
        identity,
        readEnrollmentNativeIdentity(input.stateDirectory, identitySha256),
      )
    )
      throw new BootstrapRequestConflict("Native service registration changed before admission");
    if (input.ports.assertCurrent(service, process) !== undefined)
      throw new BootstrapRequestConflict("Native service custody recheck must be synchronous");
  };
  assertCurrent();
  return { ...record, evidenceSha256: hash(JSON.stringify(record)), assertCurrent };
}

/** Capture selected file identities and their ancestor custody. Runtime content
 * digests are checked before this capture and again by the executor before effects. */
export function retainServiceFiles(files: readonly string[]): () => void {
  const retained = new Map<string, string>();
  const identify = (file: string) => {
    const stat = lstatSync(file, { bigint: true });
    if (
      realpathSync(file) !== file ||
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && (stat.mode & 0o022n) !== 0n) ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
    )
      throw new BootstrapRequestConflict("Native service file custody is unsafe");
    return [
      stat.dev,
      stat.ino,
      stat.uid,
      stat.gid,
      stat.mode,
      ...(stat.isDirectory() ? [] : [stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink]),
    ].join(":");
  };
  for (const file of files) {
    let current = file;
    for (;;) {
      const value = identify(current);
      if (retained.has(current) && retained.get(current) !== value)
        throw new BootstrapRequestConflict("Native service file custody changed");
      retained.set(current, value);
      if (retained.size > 256)
        throw new BootstrapRequestConflict("Native service custody exceeds its bound");
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return () => {
    for (const [file, value] of retained)
      if (identify(file) !== value)
        throw new BootstrapRequestConflict("Native service file custody changed");
  };
}

/** Read-only production observation. Selection and native lifetime determine the
 * slot before its existing listener is queried; readiness cannot choose a slot. */
export async function inspectMaintenanceServiceReadiness(input: {
  stateDirectory: string;
  requestId: string;
  plan: unknown;
  account: { uid: number; home: string };
  writableMountRoots: readonly string[];
  ports: MaintenanceServiceInspectionPorts;
  signal: AbortSignal;
}): Promise<MaintenanceServiceNativeObservation> {
  input.signal.throwIfAborted();
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  const retained = journal.readLifecycle().find((job) => job.id === input.requestId);
  const retainedJob = MaintenanceServiceJobSchema.parse(retained);
  const context =
    retainedJob.operation === "replacement"
      ? inspectRetainedMaintenanceServiceEffect({ ...input, retained })
      : inspectRetainedMaintenanceRecoveryEffect({ ...input, retained });
  const plan = "original" in context.plan ? context.plan.original : context.plan;
  await verifyMaintenanceLauncherArtifacts({ ...input, plan });
  const { identitySha256, planSha256, reservation } = context;
  const identity = plan.identity;
  if (identity.environment !== "host" || !identity.selectionPath || !plan.previous)
    throw new BootstrapRequestConflict("Native readiness requires enrolled Host selection");
  if (
    !isDeepStrictEqual(identity, readEnrollmentNativeIdentity(input.stateDirectory, identitySha256))
  )
    throw new BootstrapRequestConflict("Native readiness registration changed");
  const selectionBytes = await readProtectedDocument(identity.selectionPath);
  const { selectedSlot, outcome } = inspectReadinessSelection(
    context,
    JSON.parse(selectionBytes.toString("utf8")),
  );
  if (outcome === "previous")
    await verifyRetainedProcessExited(input.ports.reader, context.intent.executor);
  const selected = plan[selectedSlot];
  if (
    !selected ||
    (identity.target !== "maintenance-controller" && identity.target !== "recovery-launcher")
  )
    throw new BootstrapRequestConflict("Native readiness requires an exact maintenance runtime");
  const startup = await readMaintenanceLauncherStartup({
    setupFile: selected.setup.path,
    account: input.account,
  });
  if (
    !isDeepStrictEqual(startup.selected, selected) ||
    !isDeepStrictEqual(startup.plan.identity, identity)
  )
    throw new BootstrapRequestConflict("Native readiness selected a different release");
  const assertFiles = retainServiceFiles([
    identity.launcherPath,
    identity.selectionPath,
    selected.setup.path,
    selected.node.path,
    selected.entrypoint.path,
  ]);
  const launcher = await readProtectedDocument(identity.launcherPath);
  const decoded = await readBootstrapLauncher(
    { path: identity.launcherPath, sha256: hash(launcher) },
    input.writableMountRoots,
  );
  const expectedLauncher = maintenanceUserLauncher(plan, selectedSlot);
  if (!isDeepStrictEqual(decoded, expectedLauncher))
    throw new BootstrapRequestConflict("Native readiness launcher differs from selected release");
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const pid = loadedCoordinatorPid(service, await input.ports.reader.readService(service));
  const process = await verifyMaintenanceLauncherProcess({
    plan,
    account: input.account,
    selected: selectedSlot,
    pid,
    reader: input.ports.reader,
  });
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    assertFiles();
    if (
      !isDeepStrictEqual(
        retained,
        journal.readLifecycle().find((job) => job.id === input.requestId),
      ) ||
      !isDeepStrictEqual(
        identity,
        readEnrollmentNativeIdentity(input.stateDirectory, identitySha256),
      ) ||
      input.ports.assertCurrent(service, process) !== undefined
    )
      throw new BootstrapRequestConflict("Native readiness custody changed");
  };
  const target = identity.target;
  const controllerReadiness = () =>
    readRegisteredMaintenanceRuntimeReadiness({
      installationRoot: identity.installationRoot,
      writableMountRoots: input.writableMountRoots,
      expected: {
        installationId: identity.installationId,
        target,
        identitySha256,
        sourceCommit: selected.sourceCommit,
        artifactSha256: selected.artifactSha256,
        process,
      },
      signal: input.signal,
      assertCurrent,
    });
  const health =
    identity.target === "maintenance-controller"
      ? await controllerReadiness()
      : await inspectRecoveryPageReadiness({
          startup,
          process,
          signal: input.signal,
          writableMountRoots: input.writableMountRoots,
          assertCurrent,
        });
  const observedAt = new Date().toISOString();
  const record = MaintenanceServiceEvidenceRecordSchema.parse({
    requestId: context.job.id,
    requestRevision: reservation.requestRevision,
    planSha256,
    identitySha256,
    sourceCommit: selected.sourceCommit,
    artifactSha256: selected.artifactSha256,
    observedAt,
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
        receiptSha256: hash(selectionBytes),
        sourceCommit: selected.sourceCommit,
        artifactSha256: selected.artifactSha256,
      },
    },
  });
  health.assertCurrent();
  return {
    requestId: context.job.id,
    requestRevision: reservation.requestRevision,
    generation: reservation.generation,
    planSha256,
    identitySha256,
    outcome,
    ready: health.ready,
    sourceCommit: selected.sourceCommit,
    artifactSha256: selected.artifactSha256,
    observedAt,
    evidenceSha256: hash(JSON.stringify(record)),
    record,
    assertCurrent: health.assertCurrent,
  };
}

async function inspectRecoveryPageReadiness(input: {
  startup: Awaited<ReturnType<typeof readMaintenanceLauncherStartup>>;
  process: ProcessIdentity;
  signal: AbortSignal;
  writableMountRoots: readonly string[];
  assertCurrent(): void;
}) {
  const access = input.startup.setup.control?.recoveryAccess;
  if (!access || access.installationId !== input.startup.plan.identity.installationId)
    throw new BootstrapRequestConflict(
      "Selected recovery page has no exact listener configuration",
    );
  const assertAdmission = retainServiceFiles([input.startup.setup.nativeAdmission.path]);
  const { BootstrapAdmissionSetupSchema } = await import("./coordinator-bootstrap-host.js");
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (
        await readBootstrapPreparedFile(
          input.startup.setup.nativeAdmission,
          input.writableMountRoots,
        )
      ).toString("utf8"),
    ),
  );
  const { readSelectedMaintenanceRecoveryAssets } =
    await import("./coordinator-bootstrap-maintenance-recovery-assets.js");
  const assets = await readSelectedMaintenanceRecoveryAssets({
    runtimeDirectory: input.startup.selected.directory,
    writableMountRoots: input.writableMountRoots,
  });
  const { inspectNativeRecoveryListener } =
    await import("./coordinator-bootstrap-maintenance-recovery-native-ports.js");
  const listener = await inspectNativeRecoveryListener({
    ...admission,
    writableMountRoots: input.writableMountRoots,
    process: input.process,
    origin: access.origin,
    listenPort: access.listenPort,
    expectedAssets: assets.assets,
    signal: input.signal,
  });
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    assertAdmission();
    assets.assertCurrent();
    listener.assertCurrent();
    input.assertCurrent();
  };
  assertCurrent();
  return { ready: true, assertCurrent };
}

function inspectReadinessSelection(
  context:
    | ReturnType<typeof inspectRetainedMaintenanceServiceEffect>
    | ReturnType<typeof inspectRetainedMaintenanceRecoveryEffect>,
  value: unknown,
) {
  const selection = MaintenanceLauncherSelectionSchema.or(MaintenanceServiceSelectionSchema)
    .or(MaintenanceRecoverySelectionSchema)
    .parse(value);
  const expected = {
    requestId: context.job.id,
    requestRevision: context.reservation.requestRevision,
    intentId: context.intent.id,
    generation: context.reservation.generation,
    planSha256: context.planSha256,
  };
  if ("slot" in context) {
    if (
      !isDeepStrictEqual(selection, {
        ...expected,
        version: 3,
        operation: context.job.operation,
        slot: context.slot,
      })
    )
      throw new BootstrapRequestConflict("Native recovery readiness belongs to another generation");
    return { selectedSlot: context.slot, outcome: "candidate" as const };
  }
  const selectedSlot =
    selection.planSha256 === context.planSha256 && selection.slot === "candidate"
      ? "candidate"
      : "previous";
  if (
    selectedSlot === "candidate" &&
    !isDeepStrictEqual(selection, { ...expected, version: 2, slot: "candidate" })
  )
    throw new BootstrapRequestConflict("Native readiness belongs to another generation");
  return { selectedSlot, outcome: selectedSlot } as const;
}
