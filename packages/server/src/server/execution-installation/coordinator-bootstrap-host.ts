import { lstatSync, realpathSync } from "node:fs";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { inspectDevRegistrationConfiguration } from "./coordinator-bootstrap-dev-registration-configuration.js";
export { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify, isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ExecutionInstallationSchema,
  validateExecutionInstallation,
} from "@getpaseo/protocol/execution-installation";
import {
  assertRecoveredBootstrapBase,
  bootstrapRecoveryRelease,
  BootstrapRequestConflict,
  CoordinatorBootstrapRequests,
  type BootstrapHostBinding,
  type BootstrapReconciliationLedger,
} from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { BootstrapExecutorRecordSchema } from "./coordinator-bootstrap-process.js";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  REVIEWED_CONFIGURATION_SETTINGS,
  planConfigurationChanges,
  type ReviewedConfigurationChange,
} from "@getpaseo/protocol/coordinator-configuration-settings";
import { InstallationConfigSchema, type InstallationConfig } from "./config.js";
import { coordinatorAutomaticAuthority } from "./daemon-automation.js";
import {
  readProtectedDocument,
  withBootstrapReleaseInspection,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import {
  createNativeBootstrapServiceReader,
  readBootstrapLauncher,
  verifyBootstrapLaunchers,
  verifyLoadedBootstrapService,
  verifyRetainedProcessExited,
  verifyUnregisteredBootstrapCoordinator,
} from "./coordinator-bootstrap-service.js";

import { verifyBootstrapRecoveryArtifacts } from "./coordinator-bootstrap-boot-recovery.js";

const execute = promisify(execFile);

const CoordinatorBindingSchema = z.object({
  public: ExecutionInstallationSchema,
  ownerPasswordHash: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/),
  stateDir: z.string().startsWith("/"),
  host: z.object({ launchdService: z.string() }),
});

export interface ProtectedBootstrapHost {
  binding: BootstrapHostBinding;
  stateDirectory: string;
}

export interface BootstrapAdmissionHost {
  daemonId: string;
  configurationFile: string;
  launcherFile: string;
  docker: string;
  socket: string;
  containerId: string;
  helperPath: string;
  helperSha256: string;
}

export const BootstrapAdmissionSetupSchema = z.strictObject({
  configurationFile: z.string().startsWith("/"),
  launcherFile: z.string().startsWith("/"),
  docker: z.string().startsWith("/"),
  socket: z.string().startsWith("/"),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  helperPath: z.string().startsWith("/"),
  helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Coordinator observation and revocation share the Host ledger. Preparation,
 * approval and dispatch remain exclusively in the validating native Host service. */
export function createBootstrapReconciliationLedger(
  configurationFile: string,
  daemonId: string,
): BootstrapReconciliationLedger {
  const initial = readBootstrapHostBinding(configurationFile, daemonId);
  const readBinding = () => {
    const current = readBootstrapHostBinding(configurationFile, daemonId);
    if (
      current.stateDirectory !== initial.stateDirectory ||
      current.binding.installationId !== initial.binding.installationId ||
      current.binding.service !== initial.binding.service
    )
      throw new BootstrapRequestConflict("Coordinator binding changed. Reload its service.");
    return current.binding;
  };
  const requests = new CoordinatorBootstrapRequests(
    new FileBootstrapRequestJournal(initial.stateDirectory),
    readBinding,
    async () => {
      throw new BootstrapRequestConflict("Coordinator preparation requires native Host validation");
    },
    Date.now,
    () => {
      readBinding();
      const config = InstallationConfigSchema.parse(
        readPrivateBootstrapConfiguration(configurationFile, process.getuid!()),
      );
      return coordinatorAutomaticAuthority(config);
    },
  );
  return {
    list: () => requests.list(),
    revokeAutomatic: () => requests.revokeAutomatic(),
    cancelForReplacedHostRelease: (selected, releaseRoot) =>
      requests.cancelForReplacedHostRelease(selected, releaseRoot),
    reserveAutomaticReconciliation: (value) => requests.reserveAutomaticReconciliation(value),
    finishAutomaticReconciliation: (id, value) => requests.finishAutomaticReconciliation(id, value),
  };
}

/** Construct only from a private launcher-selected Host setup file. The caller
 * must not advertise the capability until review and execution are available. */
export async function createBootstrapReviewService(
  setupFile: string,
  daemonId: string,
  renewal?: {
    setup: z.infer<typeof BootstrapAdmissionSetupSchema>;
    verify(plan: CoordinatorBootstrapPlan): Promise<void>;
    verifyPrepared?(plan: CoordinatorBootstrapPlan, host: BootstrapAdmissionHost): Promise<void>;
  },
): Promise<CoordinatorBootstrapRequests> {
  if (process.platform !== "darwin" || !process.getuid)
    throw new BootstrapRequestConflict("Coordinator bootstrap requires native macOS Host");
  const uid = process.getuid();
  const readSetup = () =>
    BootstrapAdmissionSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const original = readSetup();
  const setup = renewal?.setup ?? original;
  const host = { ...setup, daemonId };
  const initial = readBootstrapHostBinding(setup.configurationFile, daemonId);
  const roots = await inspectBootstrapWritableMountRoots(host);
  await assertBootstrapPathsProtected(
    [
      setupFile,
      setup.configurationFile,
      setup.launcherFile,
      setup.helperPath,
      setup.docker,
      setup.socket,
      initial.stateDirectory,
    ],
    roots,
  );
  const readBinding = () => {
    if (!isDeepStrictEqual(original, readSetup()))
      throw new BootstrapRequestConflict("Bootstrap Host setup changed. Reload its service.");
    const current = readBootstrapHostBinding(setup.configurationFile, daemonId);
    if (current.stateDirectory !== initial.stateDirectory)
      throw new BootstrapRequestConflict("Bootstrap state location changed. Reload its service.");
    return current.binding;
  };
  return new CoordinatorBootstrapRequests(
    new FileBootstrapRequestJournal(initial.stateDirectory),
    readBinding,
    async (plan) => {
      await renewal?.verify(plan);
      const currentRoots = await inspectBootstrapWritableMountRoots(host);
      await assertBootstrapPathsProtected(
        [setupFile, setup.helperPath, setup.docker, setup.socket],
        currentRoots,
      );
      if (renewal?.verifyPrepared) await renewal.verifyPrepared(plan, host);
      else await verifyBootstrapPlan(plan, host);
    },
    Date.now,
    () => {
      readBinding();
      const config = InstallationConfigSchema.parse(
        readPrivateBootstrapConfiguration(setup.configurationFile, uid),
      );
      return coordinatorAutomaticAuthority(config);
    },
  );
}

function verifyMonitorBootstrapBinding(
  plan: CoordinatorBootstrapPlan,
  host: BootstrapAdmissionHost,
): void {
  if (
    plan.previewMonitorConfiguration &&
    (plan.previewMonitorConfiguration.docker !== host.docker ||
      plan.previewMonitorConfiguration.socket !== host.socket ||
      plan.previewMonitorConfiguration.containerId !== host.containerId ||
      plan.previewMonitorConfiguration.recovery.node.path !==
        bootstrapRecoveryRelease(plan).node.path ||
      plan.previewMonitorConfiguration.recovery.node.sha256 !==
        bootstrapRecoveryRelease(plan).node.sha256 ||
      plan.previewMonitorConfiguration.recovery.journal.path !==
        path.join(
          bootstrapRecoveryRelease(plan).directory,
          "packages/server/dist/server/server/execution-installation/lifecycle-journal.js",
        ) ||
      plan.previewMonitorConfiguration.recovery.queue.path !==
        path.join(
          bootstrapRecoveryRelease(plan).directory,
          "packages/server/dist/server/server/execution-installation/restarts.js",
        ))
  )
    throw new BootstrapRequestConflict(
      "Monitor configuration must bind paired container and exact retained coordinator reader",
    );
}

/** Tooling is selected only from the reviewed, fully hashed candidate release.
 * Inspect bytes as protected documents without importing or executing them. */
async function verifySourceUpdateTooling(
  plan: CoordinatorBootstrapPlan,
  writableMountRoots: readonly string[],
): Promise<void> {
  if (plan.sourceUpdateTooling !== true) return;
  const directory = path.join(plan.candidate.directory, "scripts");
  if (realpathSync(directory) !== directory)
    throw new BootstrapRequestConflict("Source update tooling requires a canonical directory");
  const files = [
    "prepare-installation-update.mjs",
    "publish-instance-web.mjs",
    "instance-web-artifact.mjs",
  ].map((name) => path.join(directory, name));
  await assertBootstrapPathsProtected([directory, ...files], writableMountRoots);
  for (const file of files) await readProtectedDocument(file);
}

/** Host setup supplies this context. Review requests cannot choose collectors,
 * Docker endpoints, the installed launcher or their own daemon identity. */
export async function verifyBootstrapPlan(
  plan: CoordinatorBootstrapPlan,
  host: BootstrapAdmissionHost,
): Promise<void> {
  return withBootstrapReleaseInspection(async (inspectRelease) => {
    const verifyPrevious = plan.supervisionRecovery
      ? verifyUnregisteredBootstrapCoordinator
      : verifyLoadedBootstrapService;
    const verifyRestorationHistory = () => {
      if (plan.supervisionRecovery)
        assertRecoveredBootstrapBase(
          plan,
          new FileBootstrapRequestJournal(plan.state.directory).read(),
        );
    };
    verifyRestorationHistory();
    const initial = readBootstrapHostBinding(host.configurationFile, host.daemonId);
    const devConfiguration = inspectBootstrapConfiguration({ plan, ...host });
    if (
      plan.nativeHelperConfiguration &&
      (plan.nativeHelperConfiguration.docker !== host.docker ||
        plan.nativeHelperConfiguration.socket !== host.socket ||
        plan.nativeHelperConfiguration.containerId !== host.containerId)
    )
      throw new BootstrapRequestConflict(
        "Helper configuration must retain the paired Host Docker identity",
      );
    if (
      devConfiguration &&
      (devConfiguration.docker.path !== host.docker ||
        devConfiguration.docker.socket !== host.socket ||
        devConfiguration.docker.containerId !== host.containerId)
    )
      throw new BootstrapRequestConflict(
        "Dev registration must retain the paired Host Docker identity",
      );
    verifyMonitorBootstrapBinding(plan, host);
    const roots = await inspectBootstrapWritableMountRoots(host);
    await assertBootstrapPathsProtected(
      [
        host.configurationFile,
        host.launcherFile,
        initial.stateDirectory,
        ...(devConfiguration?.paths ?? []),
      ],
      roots,
    );
    await verifySourceUpdateTooling(plan, roots);
    await verifyBootstrapRecoveryArtifacts(plan, roots);
    for (const release of new Set([
      plan.previous,
      plan.candidate,
      bootstrapRecoveryRelease(plan),
    ])) {
      await inspectRelease(release, roots);
    }
    const current = await readBootstrapLauncher(
      { path: host.launcherFile, sha256: plan.previous.launcher.sha256 },
      roots,
    );
    const previous = await readBootstrapLauncher(plan.previous.launcher, roots);
    const candidate = await readBootstrapLauncher(plan.candidate.launcher, roots);
    verifyBootstrapLaunchers({
      plan,
      configurationFile: host.configurationFile,
      current,
      previous,
      candidate,
    });
    if (plan.compatibleRecovery) {
      verifyBootstrapLaunchers({
        plan: { ...plan, candidate: plan.compatibleRecovery },
        configurationFile: host.configurationFile,
        current,
        previous,
        candidate: await readBootstrapLauncher(plan.compatibleRecovery.launcher, roots),
      });
    }
    const reader = await createNativeBootstrapServiceReader({ ...host, writableMountRoots: roots });
    await verifyPrevious({
      plan,
      hostUid: process.getuid!(),
      configurationFile: host.configurationFile,
      reader,
    });
    await verifyRecoveredBootstrapExit(plan, roots, reader);
    // Async collection is not a lock. Reject changed evidence before admitting the
    // request, and repeat this entire check under the dispatch fence before acting.
    const finalRoots = await inspectBootstrapWritableMountRoots(host);
    if (!isDeepStrictEqual(roots, finalRoots))
      throw new BootstrapRequestConflict("Writable container mounts changed during verification");
    verifyBootstrapConfiguration({ plan, ...host });
    if (devConfiguration) await assertBootstrapPathsProtected(devConfiguration.paths, finalRoots);
    await verifySourceUpdateTooling(plan, finalRoots);
    await verifyBootstrapRecoveryArtifacts(plan, finalRoots);
    for (const release of new Set([
      plan.previous,
      plan.candidate,
      bootstrapRecoveryRelease(plan),
    ])) {
      await inspectRelease(release, finalRoots);
    }
    await readBootstrapLauncher(
      { path: host.launcherFile, sha256: plan.previous.launcher.sha256 },
      finalRoots,
    );
    await verifyPrevious({
      plan,
      hostUid: process.getuid!(),
      configurationFile: host.configurationFile,
      reader,
    });
    await verifyRecoveredBootstrapExit(plan, finalRoots, reader);
    verifyRestorationHistory();
    if (
      !isDeepStrictEqual(initial, readBootstrapHostBinding(host.configurationFile, host.daemonId))
    )
      throw new BootstrapRequestConflict("Bootstrap Host binding changed during verification");
    devConfiguration?.assertCurrent();
  });
}

/** Same complete read-only admission, isolated from the execution lock owner.
 * A lost or timed-out result never authorizes a native effect. */
export async function verifyBootstrapPlanInChild(input: {
  plan: CoordinatorBootstrapPlan;
  host: BootstrapAdmissionHost;
  node: string;
}): Promise<void> {
  const payload = JSON.stringify({ plan: input.plan, host: input.host });
  if (Buffer.byteLength(payload) > 1024 * 1024)
    throw new BootstrapRequestConflict("Bootstrap verification input exceeds its bound");
  const expected = `verified:${createHash("sha256").update(payload).digest("hex")}\n`;
  const source = `
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifyBootstrapPlan } from ${JSON.stringify(import.meta.url)};
const bytes = readFileSync(0);
if (bytes.length > 1048576) throw Error("Bootstrap verification input exceeds its bound");
const input = JSON.parse(bytes.toString("utf8"));
await verifyBootstrapPlan(input.plan, input.host);
process.stdout.write("verified:" + createHash("sha256").update(bytes).digest("hex") + "\\n");
`;
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const fail = () =>
      reject(new BootstrapRequestConflict("Bounded bootstrap preparation did not complete"));
    const child = spawn(input.node, ["--input-type=module", "--eval", source], {
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (bytes: Buffer) => {
      output = (output + bytes.toString("utf8")).slice(0, 128);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null && output === expected) resolve();
      else fail();
    });
    child.stdin.end(payload);
  });
}

/** A claimed updater may be fenced before it writes the legacy executor record.
 * Missing legacy evidence is accepted only through the protected terminal claimed
 * recovery chain and independent absence proofs for both involved processes. */
async function verifyRecoveredBootstrapExit(
  plan: CoordinatorBootstrapPlan,
  roots: readonly string[],
  reader: { verifyProcessExited?(pid: number): Promise<void> },
): Promise<void> {
  const records = new FileBootstrapRequestJournal(plan.state.directory).read();
  const recovered = assertRecoveredBootstrapBase(plan, records);
  if (!recovered) return;
  const recordPath = path.join(
    plan.state.directory,
    `coordinator-executor-${plan.recoveredFrom!.generation}.json`,
  );
  let missing = false;
  try {
    lstatSync(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    missing = true;
  }
  if (!missing) {
    const record = BootstrapExecutorRecordSchema.parse(
      readPrivateBootstrapConfiguration(recordPath, process.getuid!()),
    );
    if (record.id !== recovered.id || record.generation !== plan.recoveredFrom!.generation)
      throw new BootstrapRequestConflict("Previous updater record changed");
    if (!reader.verifyProcessExited)
      throw new BootstrapRequestConflict("Native updater exit proof is unavailable");
    // A reused PID must not keep a retained updater lifetime alive.
    await (record.process
      ? verifyRetainedProcessExited(reader, record.process)
      : reader.verifyProcessExited(record.pid));
    return;
  }
  const { readClaimedSuccessorEvidence, verifyClaimedSuccessorExit } =
    await import("./coordinator-bootstrap-claimed-successor.js");
  const successorExecutions = records
    .slice(records.indexOf(recovered) + 1)
    .filter((record) => record.execution);
  if (
    successorExecutions.length > 1 ||
    successorExecutions.some((record) => !isDeepStrictEqual(record.plan, plan))
  )
    throw new BootstrapRequestConflict("Recovered coordinator has another successor execution");
  const { FileClaimedRecoveryReviewJournal } =
    await import("./coordinator-bootstrap-claimed-journal.js");
  const reviews = new FileClaimedRecoveryReviewJournal(plan.state.directory).readReviews();
  if (!reviews.some((review) => review.plan.original.id === recovered.id)) {
    // No executor receipt exists because admission failed before watchdog setup.
    // The promoter's exact failed sidecar record cannot authorize native effects.
    // Preserve it and require this separately approved successor to own the lock.
    new FileBootstrapRequestJournal(plan.state.directory).verifyUnpromotedFailure(recovered);
    if (!isDeepStrictEqual(plan.expectedProcess, recovered.plan.expectedProcess))
      throw new BootstrapRequestConflict("Unpromoted recovery coordinator identity changed");
    return;
  }
  // Dispatch may already have appended this successor's claim. Verify the exact
  // retained predecessor prefix, while the request journal owns dispatch exclusion.
  const evidence = await readClaimedSuccessorEvidence({
    records: records.slice(0, records.indexOf(recovered) + 1),
    identity: {
      installationId: plan.installationId,
      stateDirectory: plan.state.directory,
      service: plan.service,
    },
    roots,
  });
  if (!evidence || !isDeepStrictEqual(evidence.recoveredFrom, plan.recoveredFrom))
    throw new BootstrapRequestConflict("Exact terminal claimed recovery evidence is required");
  await verifyClaimedSuccessorExit(evidence, reader);
}

function expectedBootstrapConfiguration(
  plan: CoordinatorBootstrapPlan,
  current: InstallationConfig,
): InstallationConfig {
  // Copy each section edited below so the live configuration is never mutated.
  const expected = { ...current, host: { ...current.host }, container: { ...current.container } };
  if (plan.sourceUpdateTooling === true) {
    if (!current.sourceUpdates)
      throw new BootstrapRequestConflict("Source update tooling requires existing source updates");
    expected.sourceUpdates = {
      ...current.sourceUpdates,
      toolingDirectory: path.join(plan.candidate.directory, "scripts"),
    };
  }
  for (const change of reviewedConfigurationChanges(plan))
    applyConfigurationChange(expected, change);
  if (plan.nativeHelperConfiguration === null) delete expected.nativeHelper;
  else if (plan.nativeHelperConfiguration !== undefined)
    expected.nativeHelper = plan.nativeHelperConfiguration;
  if (plan.hostRequestsAfter !== null)
    expected.restartApprovalPolicy = { hostRequestsAfter: plan.hostRequestsAfter };
  return expected;
}

/** The plan's registered setting changes, or a conflict naming why they are refused. */
export function reviewedConfigurationChanges(
  plan: CoordinatorBootstrapPlan,
): ReviewedConfigurationChange[] {
  const result = planConfigurationChanges(plan);
  if (!result.ok) throw new BootstrapRequestConflict(result.reason);
  return result.changes;
}

/** Set or remove one registered setting. `expected` already copies the host and
 * container sections, so the live configuration is never mutated. */
function applyConfigurationChange(
  expected: InstallationConfig,
  change: ReviewedConfigurationChange,
): void {
  const location = REVIEWED_CONFIGURATION_SETTINGS[change.setting].path;
  const root = expected as unknown as Record<string, unknown>;
  const section = location.length === 1 ? root : (root[location[0]] as Record<string, unknown>);
  const key = location[location.length - 1]!;
  if (change.value === null) delete section[key];
  else section[key] = change.value;
}

interface BootstrapConfigurationInput {
  plan: CoordinatorBootstrapPlan;
  configurationFile: string;
  daemonId: string;
}

/** Compare private values without returning them to the review transport. */
export function verifyBootstrapConfiguration(input: BootstrapConfigurationInput): void {
  inspectBootstrapConfiguration(input);
}

function inspectBootstrapConfiguration(
  input: BootstrapConfigurationInput,
): ReturnType<typeof inspectDevRegistrationConfiguration> | null {
  const uid = process.getuid!();
  const configurationCustody = retainServiceFiles([
    input.configurationFile,
    input.plan.previous.configuration.path,
    input.plan.candidate.configuration.path,
    bootstrapRecoveryRelease(input.plan).configuration.path,
  ]);
  const context = readBootstrapHostBinding(input.configurationFile, input.daemonId);
  const current = InstallationConfigSchema.parse(
    readPrivateBootstrapConfiguration(input.configurationFile, uid),
  );
  const previous = InstallationConfigSchema.parse(
    readPrivateBootstrapConfiguration(input.plan.previous.configuration.path, uid),
  );
  const candidate = InstallationConfigSchema.parse(
    readPrivateBootstrapConfiguration(input.plan.candidate.configuration.path, uid),
  );
  const expectedState = {
    directory: context.stateDirectory,
    restartJournal: path.join(context.stateDirectory, "restart-jobs.json"),
    ownerSessions: path.join(context.stateDirectory, "owner-sessions.json"),
  };
  const matchingIdentity =
    context.binding.installationId === input.plan.installationId &&
    context.binding.service === input.plan.service;
  if (!matchingIdentity || !isDeepStrictEqual(input.plan.state, expectedState))
    throw new BootstrapRequestConflict("Bootstrap installation or state paths changed");
  if (!isDeepStrictEqual(current, previous))
    throw new BootstrapRequestConflict("Previous coordinator configuration no longer matches");
  const devConfiguration =
    candidate.container.persistentRegistration &&
    candidate.container.supervisorMaintenance &&
    !current.container.persistentRegistration
      ? inspectDevRegistrationConfiguration({
          plan: input.plan,
          currentFile: input.configurationFile,
          current,
          candidate,
        })
      : null;
  const expected = devConfiguration
    ? devConfiguration.configuration
    : expectedBootstrapConfiguration(input.plan, current);
  if (!isDeepStrictEqual(candidate, expected))
    throw new BootstrapRequestConflict(
      "Candidate changes configuration outside its approved policy",
    );
  const recovery = bootstrapRecoveryRelease(input.plan);
  const recoveryConfiguration = InstallationConfigSchema.parse(
    readPrivateBootstrapConfiguration(recovery.configuration.path, uid),
  );
  if (!isDeepStrictEqual(recoveryConfiguration, current))
    throw new BootstrapRequestConflict(
      "Recovery must preserve the previous coordinator configuration",
    );
  const observations = [
    { file: recovery.configuration.path, value: recoveryConfiguration },
    { file: input.configurationFile, value: current },
    { file: input.plan.previous.configuration.path, value: previous },
    { file: input.plan.candidate.configuration.path, value: candidate },
  ];
  for (const observation of observations) {
    const latest = InstallationConfigSchema.parse(
      readPrivateBootstrapConfiguration(observation.file, uid),
    );
    if (!isDeepStrictEqual(observation.value, latest))
      throw new BootstrapRequestConflict("Coordinator configuration changed during verification");
  }
  if (
    !isDeepStrictEqual(context, readBootstrapHostBinding(input.configurationFile, input.daemonId))
  )
    throw new BootstrapRequestConflict("Bootstrap Host binding changed during verification");
  devConfiguration?.assertCurrent();
  configurationCustody();
  return devConfiguration;
}
const ContainerMountInspectionSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  State: z.object({ Running: z.literal(true) }),
  Mounts: z.array(
    z.object({
      Type: z.enum(["bind", "volume", "tmpfs"]),
      Source: z.string().optional(),
      Name: z.string().optional(),
      RW: z.boolean(),
    }),
  ),
});
const VolumeInspectionSchema = z.array(
  z.object({
    Name: z.string().min(1),
    Driver: z.literal("local"),
    Scope: z.literal("local"),
    Options: z.record(z.string(), z.string()).nullable(),
  }),
);

/** Inputs must be read by the trusted Host Docker client, not supplied by an RPC.
 * Local volumes are VM storage only when their driver has no bind/device options. */
export function bootstrapWritableMountRoots(input: {
  container: unknown;
  containerId: string;
  volumes: unknown;
}): string[] {
  const container = ContainerMountInspectionSchema.parse(input.container);
  if (container.Id !== input.containerId)
    throw new BootstrapRequestConflict("Bootstrap container identity changed");
  const volumes = VolumeInspectionSchema.parse(input.volumes);
  const roots: string[] = [];
  for (const mount of container.Mounts) {
    if (!mount.RW || mount.Type === "tmpfs") continue;
    if (mount.Type === "bind") {
      if (!mount.Source || !path.isAbsolute(mount.Source))
        throw new BootstrapRequestConflict("Bootstrap mount has no absolute Host source");
      roots.push(mount.Source);
      continue;
    }
    const matches = volumes.filter((volume) => volume.Name === mount.Name);
    const volume = matches[0];
    if (matches.length !== 1 || !volume)
      throw new BootstrapRequestConflict("Bootstrap volume inspection is missing or ambiguous");
    if (volume.Options && Object.keys(volume.Options).length !== 0)
      throw new BootstrapRequestConflict("Bootstrap cannot verify a volume with driver options");
  }
  return [...new Set(roots)].sort();
}

export interface BootstrapMountInspectionCollection {
  signal: AbortSignal;
  remaining(reserveMs?: number): number;
}

export interface BootstrapMountInspectionReadLimits {
  env: { PATH: string };
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export interface BootstrapMountInspectionCommand {
  execute(
    file: string,
    args: readonly string[],
    limits: BootstrapMountInspectionReadLimits,
  ): Promise<{ stdout: string }>;
}

/** The executable, local socket and immutable container ID come from Host setup.
 * Explicit endpoint and environment prevent profile Docker variables redirecting inspection. */
export async function inspectBootstrapWritableMountRoots(
  input: { docker: string; socket: string; containerId: string },
  options: {
    collection?: BootstrapMountInspectionCollection;
    command?: BootstrapMountInspectionCommand;
  } = {},
): Promise<string[]> {
  if (process.platform !== "darwin")
    throw new BootstrapRequestConflict("Bootstrap Docker inspection requires native macOS Host");
  const declared = { docker: input.docker, socket: input.socket, containerId: input.containerId };
  if (!path.isAbsolute(declared.docker) || !path.isAbsolute(declared.socket))
    throw new BootstrapRequestConflict("Bootstrap Docker paths must be absolute");
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(declared.containerId);
  const collection = options.collection;
  const signal = collection?.signal;
  const throwIfAborted = signal?.throwIfAborted;
  const assertSignal = AbortSignal.prototype.throwIfAborted;
  const remaining = collection?.remaining;
  if (
    collection &&
    (typeof remaining !== "function" ||
      !(signal instanceof AbortSignal) ||
      typeof throwIfAborted !== "function")
  )
    throw new BootstrapRequestConflict("Bootstrap mount collection limits are invalid");
  const suppliedCommand = options.command;
  const command: BootstrapMountInspectionCommand = suppliedCommand ?? {
    async execute(file, args, limits) {
      const result = await execute(file, [...args], limits);
      return { stdout: result.stdout };
    },
  };
  const read = command.execute;
  if (typeof read !== "function")
    throw new BootstrapRequestConflict("Bootstrap mount reader is invalid");
  const limits = Object.freeze({
    env: Object.freeze({ PATH: "/usr/bin:/bin" }),
    encoding: "utf8" as const,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  function assertRetained() {
    if (
      input.docker !== declared.docker ||
      input.socket !== declared.socket ||
      input.containerId !== declared.containerId ||
      options.collection !== collection ||
      options.command !== suppliedCommand ||
      command.execute !== read ||
      (collection && (collection.signal !== signal || collection.remaining !== remaining)) ||
      (signal && signal.throwIfAborted !== throwIfAborted)
    )
      throw new BootstrapRequestConflict("Bootstrap mount inspection bindings changed");
    if (signal) assertSignal.call(signal);
  }
  function reserve(bound: number) {
    assertRetained();
    if (collection && remaining) {
      const left = remaining.call(collection, bound);
      assertRetained();
      if (!Number.isFinite(left) || left <= 0 || left < bound)
        throw new BootstrapRequestConflict("Bootstrap mount inspection deadline exceeded");
    }
  }
  async function inspect(args: string[]): Promise<unknown> {
    const fixedArgs = Object.freeze(["--host", `unix://${declared.socket}`, ...args]);
    reserve(10_000);
    const result = await read.call(command, declared.docker, fixedArgs, limits);
    reserve(0);
    return JSON.parse(result.stdout);
  }
  const container = ContainerMountInspectionSchema.parse(
    await inspect([
      "container",
      "inspect",
      "--format",
      '{"Id":{{json .Id}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}',
      declared.containerId,
    ]),
  );
  if (container.Id !== declared.containerId)
    throw new BootstrapRequestConflict("Bootstrap container identity changed");
  const volumes: unknown[] = [];
  const names = new Set<string>();
  for (const mount of container.Mounts) {
    if (mount.Type !== "volume" || !mount.RW) continue;
    const name = z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
      .parse(mount.Name);
    if (names.has(name)) continue;
    names.add(name);
    volumes.push(await inspect(["volume", "inspect", "--format", "{{json .}}", name]));
  }
  reserve(0);
  return bootstrapWritableMountRoots({ container, containerId: declared.containerId, volumes });
}

/** The file comes from the native launcher, never a profile or incoming RPC.
 * Mount exclusion is a separate Host inspection before this context is admitted. */
export function readBootstrapHostBinding(file: string, daemonId: string): ProtectedBootstrapHost {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new BootstrapRequestConflict("Bootstrap requires a native Host account");
  const config = CoordinatorBindingSchema.parse(readPrivateBootstrapConfiguration(file, uid));
  validateExecutionInstallation(config.public);
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!host || host.serverId !== daemonId)
    throw new BootstrapRequestConflict("Bootstrap is available only on the configured Host daemon");
  const servicePrefix = `gui/${uid}/local.vorteo.${config.public.installationId}`;
  if (config.host.launchdService !== `${servicePrefix}.host`)
    throw new BootstrapRequestConflict(
      "Bootstrap configuration has a different Host service identity",
    );
  if (realpathSync(config.stateDir) !== config.stateDir)
    throw new BootstrapRequestConflict("Coordinator state requires its canonical directory");
  const state = lstatSync(config.stateDir);
  if (!state.isDirectory() || state.uid !== uid || (state.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Coordinator state requires a private Host directory");
  return {
    binding: {
      environment: "host",
      installationId: config.public.installationId,
      service: `${servicePrefix}.installation`,
      ownerPasswordHash: config.ownerPasswordHash,
    },
    stateDirectory: config.stateDir,
  };
}
