import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
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
} from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { BootstrapExecutorRecordSchema } from "./coordinator-bootstrap-process.js";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { InstallationConfigSchema } from "./config.js";
import {
  verifyBootstrapReleaseArtifacts,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import {
  createNativeBootstrapServiceReader,
  readBootstrapLauncher,
  verifyBootstrapLaunchers,
  verifyLoadedBootstrapService,
} from "./coordinator-bootstrap-service.js";

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

/** Construct only from a private launcher-selected Host setup file. The caller
 * must not advertise the capability until review and execution are available. */
export async function createBootstrapReviewService(
  setupFile: string,
  daemonId: string,
): Promise<CoordinatorBootstrapRequests> {
  if (process.platform !== "darwin" || !process.getuid)
    throw new BootstrapRequestConflict("Coordinator bootstrap requires native macOS Host");
  const uid = process.getuid();
  const readSetup = () =>
    BootstrapAdmissionSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const setup = readSetup();
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
    if (!isDeepStrictEqual(setup, readSetup()))
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
      const currentRoots = await inspectBootstrapWritableMountRoots(host);
      await assertBootstrapPathsProtected(
        [setupFile, setup.helperPath, setup.docker, setup.socket],
        currentRoots,
      );
      await verifyBootstrapPlan(plan, host);
    },
  );
}

/** Host setup supplies this context. Review requests cannot choose collectors,
 * Docker endpoints, the installed launcher or their own daemon identity. */
export async function verifyBootstrapPlan(
  plan: CoordinatorBootstrapPlan,
  host: BootstrapAdmissionHost,
): Promise<void> {
  const initial = readBootstrapHostBinding(host.configurationFile, host.daemonId);
  verifyBootstrapConfiguration({ plan, ...host });
  if (
    plan.nativeHelperConfiguration &&
    (plan.nativeHelperConfiguration.docker !== host.docker ||
      plan.nativeHelperConfiguration.socket !== host.socket ||
      plan.nativeHelperConfiguration.containerId !== host.containerId)
  )
    throw new BootstrapRequestConflict(
      "Helper configuration must retain the paired Host Docker identity",
    );
  const roots = await inspectBootstrapWritableMountRoots(host);
  await assertBootstrapPathsProtected(
    [host.configurationFile, host.launcherFile, initial.stateDirectory],
    roots,
  );
  for (const release of new Set([plan.previous, plan.candidate, bootstrapRecoveryRelease(plan)]))
    await verifyBootstrapReleaseArtifacts(release, roots);
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
  await verifyLoadedBootstrapService({
    plan,
    hostUid: process.getuid!(),
    configurationFile: host.configurationFile,
    reader,
  });
  const recovered = assertRecoveredBootstrapBase(
    plan,
    new FileBootstrapRequestJournal(initial.stateDirectory).read(),
  );
  if (recovered) {
    const recordPath = path.join(
      initial.stateDirectory,
      `coordinator-executor-${plan.recoveredFrom!.generation}.json`,
    );
    const record = BootstrapExecutorRecordSchema.parse(
      readPrivateBootstrapConfiguration(recordPath, process.getuid!()),
    );
    if (record.id !== recovered.id || record.generation !== plan.recoveredFrom!.generation)
      throw new BootstrapRequestConflict("Previous updater record changed");
    await reader.verifyProcessExited(record.pid);
  }
  // Async collection is not a lock. Reject changed evidence before admitting the
  // request, and repeat this entire check under the dispatch fence before acting.
  const finalRoots = await inspectBootstrapWritableMountRoots(host);
  if (!isDeepStrictEqual(roots, finalRoots))
    throw new BootstrapRequestConflict("Writable container mounts changed during verification");
  verifyBootstrapConfiguration({ plan, ...host });
  for (const release of new Set([plan.previous, plan.candidate, bootstrapRecoveryRelease(plan)]))
    await verifyBootstrapReleaseArtifacts(release, finalRoots);
  await readBootstrapLauncher(
    { path: host.launcherFile, sha256: plan.previous.launcher.sha256 },
    finalRoots,
  );
  await verifyLoadedBootstrapService({
    plan,
    hostUid: process.getuid!(),
    configurationFile: host.configurationFile,
    reader,
  });
  if (!isDeepStrictEqual(initial, readBootstrapHostBinding(host.configurationFile, host.daemonId)))
    throw new BootstrapRequestConflict("Bootstrap Host binding changed during verification");
}

/** Compare private values without returning them to the review transport. */
export function verifyBootstrapConfiguration(input: {
  plan: CoordinatorBootstrapPlan;
  configurationFile: string;
  daemonId: string;
}): void {
  const context = readBootstrapHostBinding(input.configurationFile, input.daemonId);
  const uid = process.getuid!();
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
  const expected = { ...current, container: { ...current.container } };
  if (input.plan.factoryRuntimeAdoptionConfiguration === null)
    delete expected.container.factoryRuntimeAdoption;
  else if (input.plan.factoryRuntimeAdoptionConfiguration !== undefined)
    expected.container.factoryRuntimeAdoption = input.plan.factoryRuntimeAdoptionConfiguration;
  if (input.plan.nativeHelperConfiguration === null) delete expected.nativeHelper;
  else if (input.plan.nativeHelperConfiguration !== undefined)
    expected.nativeHelper = input.plan.nativeHelperConfiguration;
  if (input.plan.hostRequestsAfter !== null)
    expected.restartApprovalPolicy = { hostRequestsAfter: input.plan.hostRequestsAfter };
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

/** The executable, local socket and immutable container ID come from Host setup.
 * Explicit endpoint and environment prevent profile Docker variables redirecting inspection. */
export async function inspectBootstrapWritableMountRoots(input: {
  docker: string;
  socket: string;
  containerId: string;
}): Promise<string[]> {
  if (process.platform !== "darwin")
    throw new BootstrapRequestConflict("Bootstrap Docker inspection requires native macOS Host");
  if (!path.isAbsolute(input.docker) || !path.isAbsolute(input.socket))
    throw new BootstrapRequestConflict("Bootstrap Docker paths must be absolute");
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.containerId);
  async function inspect(args: string[]): Promise<unknown> {
    const result = await execute(input.docker, ["--host", `unix://${input.socket}`, ...args], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  }
  const container = ContainerMountInspectionSchema.parse(
    await inspect([
      "container",
      "inspect",
      "--format",
      '{"Id":{{json .Id}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}',
      input.containerId,
    ]),
  );
  if (container.Id !== input.containerId)
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
  return bootstrapWritableMountRoots({ container, containerId: input.containerId, volumes });
}

export function readPrivateBootstrapConfiguration(file: string, uid: number): unknown {
  if (realpathSync(file) !== file)
    throw new BootstrapRequestConflict("Bootstrap configuration requires a canonical Host path");
  const parent = lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Bootstrap configuration requires a private Host directory");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size > 1024n * 1024n
    )
      throw new BootstrapRequestConflict("Bootstrap configuration must be a private owned file");
    const bytes = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      after.ctimeNs !== current.ctimeNs ||
      after.mtimeNs !== current.mtimeNs
    )
      throw new BootstrapRequestConflict("Bootstrap configuration changed while reading");
    return JSON.parse(bytes);
  } finally {
    closeSync(fd);
  }
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
