import {
  InitialHostSupervisorPreconditionSchema,
  type InitialHostSupervisorPrecondition,
} from "./host-supervisor-contract.js";
export { InitialHostSupervisorPreconditionSchema } from "./host-supervisor-contract.js";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DaemonMaintenanceProcessSchema as RuntimeProcessSchema } from "@getpaseo/protocol/maintenance-interruption";
import { execFile, execFileSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import { hostLaunchdService, type InstallationConfig } from "../config.js";
import { connectInstallationDaemon } from "../daemon.js";
import {
  BootstrapAdmissionSetupSchema,
  bootstrapWritableMountRoots,
  readPrivateBootstrapConfiguration,
} from "../coordinator-bootstrap-host.js";
import {
  assertBootstrapPathsProtected,
  readProtectedDocument,
  readBootstrapPreparedFile,
  verifyBootstrapPreparedDependency,
} from "../coordinator-bootstrap-artifact.js";
import {
  createNativeBootstrapServiceReader,
  loadedCoordinatorPid,
  verifyRetainedProcessExited,
} from "../coordinator-bootstrap-service.js";
import { ProcessObservationSchema } from "../coordinator-bootstrap-process.js";
import {
  EnrollmentNativeIdentitySchema,
  enrollmentNativeIdentityDigest,
  type EnrollmentNativeIdentity,
} from "./native-identity.js";
import { inspectEffectiveMaintenanceConfiguration } from "../coordinator-bootstrap-maintenance-observation-runtime.js";

import {
  DEV_REGISTRATION_INSPECTION_SCRIPT,
  DevStartupSchema,
  readDevRegistrationBinding,
  verifyDevRegistrationObservation,
} from "./dev-registration.js";

const execute = promisify(execFile);
const COMMAND_LIMITS: { timeout: number; maxBuffer: number; env: { PATH: string } } = {
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
  env: { PATH: "/usr/bin:/bin" },
};
const SourceSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) });

interface InitialHostMigrationProof {
  precondition: InitialHostSupervisorPrecondition;
  preconditionSha256: string;
  observedAt: string;
  assertCurrent(): void;
}
type HostInspectionPurpose =
  | { kind: "standing" }
  | { kind: "initial-migration"; precondition: InitialHostSupervisorPrecondition };

export interface EnrollmentDaemonObservation {
  /** Synchronous retained custody check for locked admission. Does not refresh
   * kernel process or Docker evidence, acquire locks, or authorize effects. */
  assertCurrent(): void;
  descriptor: EnrollmentNativeIdentity;
  identitySha256: string;
  observedAt: string;
  /** Protected coordinator storage, distinct from the Host daemon PASEO_HOME. */
  custodyStateDirectory: string;
  /** Canonical Host bind roots writable by the configured immutable Dev container.
   * Uses the existing bootstrap volume-driver checks, not guest-reported mounts. */
  writableMountRoots: string[];
  serverId: string;
  workerInstanceId?: string;
  restartDrainId?: string | null;
  selectedRelease: string;
  sourceCommit: string;
  supervisor: z.infer<typeof RuntimeProcessSchema>;
  worker: z.infer<typeof RuntimeProcessSchema>;
  /** Independent native exit verification, not a comparison of current PIDs. */
  verifyPreviousWorkerExited?(previous: z.infer<typeof RuntimeProcessSchema>): Promise<void>;
}

/** Read-only ports. Tests replace native observations, never lifecycle effects.
 * Implementations must honor command deadlines and return actual kernel/daemon evidence. */
export interface EnrollmentDaemonInspectionPorts {
  platform: string;
  uid: number;
  command(file: string, args: string[], limits: typeof COMMAND_LIMITS): Promise<string>;
  processes(
    setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
    roots: string[],
  ): Promise<{
    inspectRunningProcess(pid: number): Promise<unknown>;
    verifyProcessExited?(pid: number): Promise<void>;
    inspectProcess?(pid: number): Promise<unknown>;
  }>;
  daemon(
    config: InstallationConfig,
    kind: "host" | "container",
  ): Promise<{
    serverId: string;
    pid: number;
    workerInstanceId?: string;
    workerInstanceSupport?: "supported" | "unsupported";
    restartDrainId?: string | null;
  }>;
  now(): number;
  /** Migration-only synchronous native custody. No ordinary evidence is produced. */
  retainInitialHostCustody?(
    setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
    roots: string[],
    precondition: InitialHostSupervisorPrecondition,
  ): Promise<() => void>;
}
const nativePorts: EnrollmentDaemonInspectionPorts = {
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  async command(file, args, limits) {
    return (await execute(file, args, limits)).stdout;
  },
  processes: (setup, roots) =>
    createNativeBootstrapServiceReader({ ...setup, writableMountRoots: roots }),
  async daemon(config, kind) {
    const client = await connectInstallationDaemon(config, kind);
    try {
      const info = client.getLastServerInfoMessage();
      const status = await client.getDaemonStatus({ timeout: 10_000 });
      if (info?.features?.heldIdleRestart === true) {
        const held = await client.restartServer(undefined, undefined, {
          idleMode: "inspect",
          timeout: 10_000,
        });
        requireMatch(
          held.impact?.workerPid === status.pid && held.impact.workerInstanceId,
          "Worker lifetime observation is unavailable",
        );
        return {
          serverId: info.serverId,
          pid: status.pid,
          workerInstanceId: held.impact.workerInstanceId,
          workerInstanceSupport: "supported",
          restartDrainId: held.impact.restartDrainId,
        };
      }
      return { serverId: info!.serverId, pid: status.pid, workerInstanceSupport: "unsupported" };
    } finally {
      await client.close();
    }
  },
  now: Date.now,
  retainInitialHostCustody: retainNativeInitialHostCustody,
};
function requireMatch(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function inside(root: string, file: string): boolean {
  return file.startsWith(root + path.sep);
}

async function protectedPaths(files: string[], roots: string[], uid: number): Promise<void> {
  await assertBootstrapPathsProtected(files, roots);
  for (const file of files) {
    requireMatch((await realpath(file)) === file, "Native custody requires canonical paths");
    const stat = await lstat(file);
    requireMatch(
      stat.uid === uid && (stat.mode & 0o022) === 0 && (stat.isFile() || stat.isDirectory()),
      "Native custody is not protected",
    );
  }
}

/** File timestamps include ctime so in-place writes cannot hide behind restored
 * mtime. Directory contents may change during normal journal writes; retain their
 * identity and permissions, not their contents' timestamps. */
function retainCustody() {
  const retained = new Map<string, string>();
  function identity(file: string): string {
    const stat = lstatSync(file, { bigint: true });
    requireMatch(
      stat.isFile() || stat.isDirectory() || stat.isSymbolicLink(),
      "Unsupported retained native custody object",
    );
    return [
      realpathSync(file),
      stat.dev,
      stat.ino,
      stat.uid,
      stat.gid,
      stat.mode,
      ...(stat.isDirectory() ? [] : [stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]),
    ].join(":");
  }
  function capture(files: string[]): void {
    for (const file of files) {
      let current = file;
      for (;;) {
        const value = identity(current);
        const previous = retained.get(current);
        requireMatch(previous === undefined || previous === value, "Native custody changed");
        retained.set(current, value);
        requireMatch(retained.size <= 256, "Native custody exceeds its path bound");
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  return {
    capture,
    assertCurrent(): void {
      for (const [file, value] of retained)
        requireMatch(identity(file) === value, "Retained native custody changed");
    },
  };
}

/** Throws on unavailable, ambiguous or mismatched evidence. Callers project that as
 * unknown, never healthy or authorized. This observation grants no lifecycle authority. */
export async function inspectEnrollmentDaemonIdentity(
  config: InstallationConfig,
  expectedDescriptor: EnrollmentNativeIdentity,
  ports: EnrollmentDaemonInspectionPorts = nativePorts,
): Promise<EnrollmentDaemonObservation> {
  return inspectDaemonCustody(config, expectedDescriptor, ports, { kind: "standing" });
}

/** This proof can bind an initial migration plan only. It is not convertible to
 * EnrollmentDaemonObservation and cannot authorize ordinary standing effects. */
export async function inspectInitialHostSupervisorMigration(
  config: InstallationConfig,
  value: unknown,
  ports: EnrollmentDaemonInspectionPorts = nativePorts,
): Promise<InitialHostMigrationProof> {
  const precondition = InitialHostSupervisorPreconditionSchema.parse(value);
  requireMatch(
    precondition.identity.environment === "host" && precondition.identity.target === "host",
    "Initial migration requires the enrolled Host identity",
  );
  requireMatch(
    (precondition.workerInstanceSupport === "unsupported") ===
      (precondition.workerInstanceId === null),
    "Initial Host worker capability binding is inconsistent",
  );
  const observation = await inspectDaemonCustody(config, precondition.identity, ports, {
    kind: "initial-migration",
    precondition,
  });
  const preconditionSha256 = sha(precondition);
  const assertCurrent = () => {
    requireMatch(sha(precondition) === preconditionSha256, "Initial Host precondition changed");
    observation.assertCurrent();
    requireMatch(sha(precondition) === preconditionSha256, "Initial Host precondition changed");
  };
  assertCurrent();
  return { precondition, preconditionSha256, observedAt: observation.observedAt, assertCurrent };
}

async function inspectDaemonCustody(
  config: InstallationConfig,
  expectedDescriptor: EnrollmentNativeIdentity,
  ports: EnrollmentDaemonInspectionPorts,
  purpose: HostInspectionPurpose,
): Promise<EnrollmentDaemonObservation> {
  const expected = EnrollmentNativeIdentitySchema.parse(expectedDescriptor);
  enrollmentNativeIdentityDigest(expected);
  requireMatch(
    ports.platform === "darwin" && ports.uid >= 0,
    "Native daemon inspection requires macOS Host",
  );
  requireMatch(
    expected.target === "host" || expected.target === "container-daemon",
    "Unsupported daemon target",
  );
  requireMatch(
    expected.custodyOwnerUid === ports.uid &&
      expected.installationId === config.public.installationId,
    "Installation custody or identity differs",
  );
  const clock = ports.now.bind(ports);
  const monotonic = performance.now.bind(performance);
  const monotonicStarted = monotonic();
  const started = clock();
  // Nested collectors receive the original wall clock with a monotonic floor,
  // so a clock rollback cannot restart their available collection window.
  const collectionClock = () => Math.max(clock(), started + monotonic() - monotonicStarted);
  const command = ports.command.bind(ports);
  ports = {
    ...ports,
    now: clock,
    command: async (file, args, limits) => {
      const remaining = 60_000 - (collectionClock() - started);
      requireMatch(remaining > 0, "Native observation exceeded freshness deadline");
      const result = await command(file, args, {
        ...limits,
        timeout: Math.min(limits.timeout, remaining),
      });
      requireMatch(
        collectionClock() - started <= 60_000,
        "Native observation exceeded freshness deadline",
      );
      return result;
    },
  };
  const custody = retainCustody();
  if (purpose.kind === "initial-migration")
    custody.capture(migrationFiles(purpose.precondition).map((file) => file.path));
  const anchor = path.join(expected.installationRoot, "coordinator-bootstrap-runner.json");
  custody.capture([expected.installationRoot, config.stateDir, anchor]);
  const runner = z
    .object({ admissionSetupFile: z.string().startsWith("/") })
    .parse(readPrivateBootstrapConfiguration(anchor, ports.uid));
  custody.capture([runner.admissionSetupFile]);
  const setup = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(runner.admissionSetupFile, ports.uid),
  );
  custody.capture([setup.configurationFile]);
  const docker = async (args: string[]) =>
    JSON.parse(
      await ports.command(
        setup.docker,
        ["--host", `unix://${setup.socket}`, ...args],
        COMMAND_LIMITS,
      ),
    );
  const inspectMounts = async () => {
    const container = z
      .object({
        Id: z.string(),
        State: z.object({ Running: z.boolean() }),
        Path: z.string(),
        Args: z.array(z.string()),
        Config: z.object({
          Entrypoint: z.array(z.string()).nullable(),
          Cmd: z.array(z.string()).nullable(),
        }),
        Mounts: z.array(
          z
            .object({ Type: z.string(), RW: z.boolean(), Name: z.string().optional() })
            .passthrough(),
        ),
      })
      .parse(
        await docker([
          "container",
          "inspect",
          "--format",
          '{"Id":{{json .Id}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}},"Path":{{json .Path}},"Args":{{json .Args}},"Config":{"Entrypoint":{{json .Config.Entrypoint}},"Cmd":{{json .Config.Cmd}}}}',
          setup.containerId,
        ]),
      );
    requireMatch(
      container.Id === setup.containerId && container.State.Running,
      "Configured Docker container is absent or replaced",
    );
    requireMatch(container.Mounts.length <= 128, "Too many container mounts to inspect");
    const volumes = [];
    for (const name of new Set(
      container.Mounts.filter((m) => m.Type === "volume" && m.RW).map((m) => m.Name),
    )) {
      requireMatch(name && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name), "Invalid container volume");
      volumes.push(await docker(["volume", "inspect", "--format", "{{json .}}", name]));
    }
    return {
      container,
      roots: bootstrapWritableMountRoots({ container, containerId: setup.containerId, volumes }),
    };
  };
  const mounts = await inspectMounts();
  await protectedPaths(
    [
      expected.installationRoot,
      config.stateDir,
      anchor,
      runner.admissionSetupFile,
      setup.configurationFile,
    ],
    mounts.roots,
    ports.uid,
  );
  const effective = await inspectEffectiveMaintenanceConfiguration({
    configuration: config,
    admission: setup,
    writableMountRoots: mounts.roots,
    collection: { deadline: started + 60_000, now: collectionClock },
  });
  const effectiveSetup = effective.admission;
  const assertEffective = effective.assertCurrent;
  const assertEffectiveRetained = effective.assertRetained;
  let assertMigrationCurrent = () => {};
  if (purpose.kind === "initial-migration") {
    requireMatch(ports.retainInitialHostCustody, "Initial Host native custody is unavailable");
    await verifyInitialHostFiles(
      config,
      effectiveSetup,
      purpose.precondition,
      mounts.roots,
      ports.uid,
    );
    assertMigrationCurrent = await ports.retainInitialHostCustody(
      effectiveSetup,
      mounts.roots,
      purpose.precondition,
    );
  }
  const kind = expected.environment === "host" ? "host" : "container";
  const daemon = await ports.daemon(config, kind);
  const server = config.public.environments.find((item) => item.kind === kind);
  requireMatch(
    server &&
      daemon.serverId === server.serverId &&
      Number.isSafeInteger(daemon.pid) &&
      daemon.pid > 0,
    "Connected daemon identity differs",
  );
  if (expected.environment === "container") {
    requireMatch(config.containerSourceUpdates, "Dev source inspection is unavailable");
    custody.capture([config.containerSourceUpdates.receiptFile]);
    await protectedPaths([config.containerSourceUpdates.receiptFile], mounts.roots, ports.uid);
  }
  const observed =
    expected.environment === "host"
      ? await inspectHost(
          config,
          expected,
          effectiveSetup,
          mounts.roots,
          daemon.pid,
          ports,
          custody,
          purpose,
        )
      : await inspectDev(config, expected, effectiveSetup, daemon.pid, ports, {
          custody,
          roots: mounts.roots,
          startup: {
            path: mounts.container.Path,
            args: mounts.container.Args,
            entrypoint: mounts.container.Config.Entrypoint,
            cmd: mounts.container.Config.Cmd,
          },
          writableMounts: mounts.container.Mounts.filter((mount) => mount.RW).map(
            (mount) =>
              z.object({ Destination: z.string().startsWith("/") }).parse(mount).Destination,
          ),
        });
  requireMatch(
    isDeepStrictEqual(mounts, await inspectMounts()),
    "Docker custody changed during inspection",
  );
  requireMatch(
    isDeepStrictEqual(
      runner,
      z
        .object({ admissionSetupFile: z.string().startsWith("/") })
        .parse(readPrivateBootstrapConfiguration(anchor, ports.uid)),
    ) &&
      isDeepStrictEqual(
        setup,
        BootstrapAdmissionSetupSchema.parse(
          readPrivateBootstrapConfiguration(runner.admissionSetupFile, ports.uid),
        ),
      ) &&
      isDeepStrictEqual(
        config,
        readPrivateBootstrapConfiguration(effectiveSetup.configurationFile, ports.uid),
      ),
    "Native configuration changed during inspection",
  );
  const finalDaemon = await ports.daemon(config, kind);
  requireMatch(isDeepStrictEqual(daemon, finalDaemon), "Daemon changed during inspection");
  requireMatch(
    collectionClock() - started <= 60_000,
    "Native observation exceeded freshness deadline",
  );
  const descriptor = EnrollmentNativeIdentitySchema.parse(observed.descriptor);
  requireMatch(
    enrollmentNativeIdentityDigest(descriptor) === enrollmentNativeIdentityDigest(expected),
    "Observed native identity differs from enrollment",
  );
  if (purpose.kind === "initial-migration")
    requireMatch(
      daemon.serverId === purpose.precondition.serverId &&
        daemon.workerInstanceSupport === purpose.precondition.workerInstanceSupport &&
        (daemon.workerInstanceId ?? null) === purpose.precondition.workerInstanceId,
      "Initial Host authenticated worker changed",
    );
  const observedAt = new Date(ports.now()).toISOString();
  const assertCurrent = () => {
    custody.assertCurrent();
    assertEffective();
    custody.assertCurrent();
    if (purpose.kind === "initial-migration") {
      const age = ports.now() - Date.parse(observedAt);
      requireMatch(age >= 0 && age < 30_000, "Initial Host custody proof expired");
      requireMatch(
        assertMigrationCurrent() === undefined,
        "Initial Host custody must be synchronous",
      );
      custody.assertCurrent();
      const finalAge = ports.now() - Date.parse(observedAt);
      requireMatch(finalAge >= 0 && finalAge < 30_000, "Initial Host custody proof expired");
    }
    requireMatch(
      effective.assertCurrent === assertEffective &&
        effective.assertRetained === assertEffectiveRetained,
      "Effective configuration custody callbacks changed",
    );
    assertEffectiveRetained();
    custody.assertCurrent();
  };
  const writableMountRoots = await Promise.all(mounts.roots.map((root) => realpath(root)));
  const custodyStateDirectory = await realpath(config.stateDir);
  requireMatch(
    collectionClock() - started <= 60_000,
    "Native observation exceeded freshness deadline",
  );
  assertCurrent();
  requireMatch(
    collectionClock() - started <= 60_000,
    "Native observation exceeded freshness deadline",
  );
  assertEffectiveRetained();
  custody.assertCurrent();
  return {
    ...observed,
    assertCurrent,
    descriptor,
    identitySha256: enrollmentNativeIdentityDigest(descriptor),
    writableMountRoots,
    custodyStateDirectory,
    serverId: daemon.serverId,
    ...(daemon.workerInstanceId ? { workerInstanceId: daemon.workerInstanceId } : {}),
    ...(daemon.restartDrainId !== undefined ? { restartDrainId: daemon.restartDrainId } : {}),
    observedAt,
  };
}

function migrationFiles(precondition: InitialHostSupervisorPrecondition) {
  return [
    precondition.configuration,
    precondition.launcher,
    precondition.clientConfiguration,
    precondition.node,
    precondition.supervisorEntrypoint,
    precondition.workerEntrypoint,
    precondition.sourceReceipt,
  ];
}

async function verifyInitialHostFiles(
  config: InstallationConfig,
  setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
  precondition: InitialHostSupervisorPrecondition,
  roots: string[],
  uid: number,
) {
  const startup = config.host.startupValidation;
  requireMatch(startup, "Initial Host startup configuration is unavailable");
  const selected = precondition.selectedRelease;
  requireMatch(
    precondition.configuration.path === setup.configurationFile &&
      precondition.launcher.path === precondition.identity.launcherPath &&
      precondition.node.path === startup.node &&
      precondition.hostEndpoint === config.host.endpoint &&
      precondition.supervisorEntrypoint.path ===
        path.join(selected, "packages/server/dist/scripts/supervisor-entrypoint.js") &&
      precondition.workerEntrypoint.path ===
        path.join(selected, "packages/server/dist/server/server/daemon-worker.js") &&
      precondition.sourceReceipt.path === path.join(selected, ".installation-source.json") &&
      precondition.registration.environment.VORTEO_INSTALLATION_CLIENT_CONFIG ===
        precondition.clientConfiguration.path &&
      precondition.supervisor.argumentsSha256 !== sha([startup.node, startup.entrypoint]),
    "Initial Host migration precondition differs from configuration",
  );
  const files = migrationFiles(precondition);
  await protectedPaths(
    files.map((file) => file.path),
    roots,
    uid,
  );
  for (const file of files) {
    if (file === precondition.node) await verifyBootstrapPreparedDependency(file, roots);
    else await readBootstrapPreparedFile(file, roots);
  }
}

function verifyInitialHostRegistration(
  service: string,
  plist: {
    Program?: string;
    ProgramArguments: string[];
    EnvironmentVariables: Record<string, string>;
  },
  precondition: Pick<InitialHostSupervisorPrecondition, "registration">,
) {
  const { loadedEnvironment, ...diskRegistration } = precondition.registration;
  requireMatch(
    isDeepStrictEqual(diskRegistration, {
      program: plist.Program ?? null,
      arguments: plist.ProgramArguments,
      environment: plist.EnvironmentVariables,
    }),
    "Initial Host registered launcher changed",
  );
  const sections = [...service.matchAll(/^\tenvironment = \{\n([\s\S]*?)^\t\}$/gm)];
  requireMatch(sections.length === 1, "Initial Host registered environment is unavailable");
  const entries = sections[0][1]
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf(" => ");
      requireMatch(separator > 0, "Initial Host registered environment is malformed");
      return [line.slice(0, separator).trim(), line.slice(separator + 4)] as const;
    });
  const actualEnvironment = Object.fromEntries(entries);
  requireMatch(
    new Set(entries.map(([key]) => key)).size === entries.length &&
      isDeepStrictEqual(actualEnvironment, loadedEnvironment) &&
      Object.entries(precondition.registration.environment).every(
        ([key, value]) => actualEnvironment[key] === value,
      ),
    "Initial Host registered environment changed",
  );
}

async function retainNativeInitialHostCustody(
  setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
  roots: string[],
  precondition: InitialHostSupervisorPrecondition,
): Promise<() => void> {
  return retainNativeHostServiceCustody(setup, roots, precondition);
}

/** Read-only service/process custody shared by the legacy precondition and a
 * strictly inspected candidate. It grants no ordinary or migration authority. */
export async function retainNativeHostServiceCustody(
  setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
  roots: string[],
  value: Pick<
    InitialHostSupervisorPrecondition,
    "identity" | "registration" | "supervisor" | "worker"
  >,
  commands?: { run(file: string, args: string[]): string; now(): number },
): Promise<() => void> {
  const precondition = structuredClone(value);
  const helperReference = { path: setup.helperPath, sha256: setup.helperSha256 };
  const custody = retainCustody();
  custody.capture([helperReference.path]);
  const helper = (await readBootstrapPreparedFile(helperReference, [...roots])).toString("utf8");
  const identity = precondition.identity;
  requireMatch(identity.environment === "host", "Initial Host service identity required");
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const options = {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 2000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8" as const,
  };
  const run =
    commands?.run ?? ((file: string, args: string[]) => execFileSync(file, args, options));
  const now = commands?.now ?? (() => performance.now());
  return () => {
    const deadline = now() + 8_000;
    const budget = () =>
      requireMatch(now() < deadline, "Host native custody verification exceeded its deadline");
    custody.assertCurrent();
    const registration = run("/bin/launchctl", ["print", service]);
    budget();
    requireMatch(
      loadedCoordinatorPid(service, registration) === precondition.supervisor.pid,
      "Initial Host registered process changed",
    );
    verifyHostRegistration(
      registration,
      precondition.registration.arguments,
      identity.launcherPath,
      precondition.registration.environment.PASEO_HOME,
    );
    verifyInitialHostRegistration(
      registration,
      {
        ...(precondition.registration.program === null
          ? {}
          : { Program: precondition.registration.program }),
        ProgramArguments: precondition.registration.arguments,
        EnvironmentVariables: precondition.registration.environment,
      },
      precondition,
    );
    for (const expected of [precondition.supervisor, precondition.worker]) {
      budget();
      const { stopped: _stopped, ...current } = ProcessObservationSchema.extend({
        stopped: z.literal(false),
      }).parse(
        JSON.parse(
          run("/usr/bin/python3", [
            "-I",
            "-B",
            "-c",
            helper,
            String(expected.pid),
            "--require-running",
          ]),
        ),
      );
      requireMatch(isDeepStrictEqual(current, expected), "Initial Host process custody changed");
      budget();
    }
    custody.assertCurrent();
    budget();
  };
}

interface HostProcessCustody {
  supervisor: z.infer<typeof RuntimeProcessSchema>;
  worker: z.infer<typeof RuntimeProcessSchema>;
  supervisorPid: number;
  workerPid: number;
  uid: number;
  node: string;
  selectedRelease: string;
  argv: string[];
  purpose: HostInspectionPurpose;
}

function verifyHostProcesses(input: HostProcessCustody): void {
  const { supervisor, worker } = input;
  requireMatch(
    supervisor.pid === input.supervisorPid &&
      supervisor.uid === input.uid &&
      supervisor.parentPid === 1 &&
      supervisor.executable === input.node &&
      (input.purpose.kind === "standing"
        ? supervisor.argumentsSha256 === sha(input.argv)
        : isDeepStrictEqual(supervisor, input.purpose.precondition.supervisor)),
    "Host supervisor does not match registration",
  );
  requireMatch(
    worker.pid === input.workerPid &&
      worker.uid === input.uid &&
      worker.parentPid === input.supervisorPid &&
      worker.bootId === supervisor.bootId &&
      worker.executable === input.node &&
      worker.argumentsSha256 ===
        sha([
          input.node,
          path.join(input.selectedRelease, "packages/server/dist/server/server/daemon-worker.js"),
        ]),
    "Host worker differs from selected source",
  );
}

async function inspectHost(
  config: InstallationConfig,
  expected: Extract<EnrollmentNativeIdentity, { environment: "host" }>,
  setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
  roots: string[],
  pid: number,
  ports: EnrollmentDaemonInspectionPorts,
  custody: ReturnType<typeof retainCustody>,
  purpose: HostInspectionPurpose,
) {
  const source = config.sourceUpdates;
  const startup = config.host.startupValidation;
  requireMatch(source && startup, "Host selected-source inspection is unsupported");
  requireMatch(
    hostLaunchdService(config) === `${expected.serviceDomain}/${expected.serviceLabel}`,
    "Host service differs",
  );
  const selectionPath = source.currentReleaseLink;
  custody.capture([
    selectionPath,
    expected.launcherPath,
    startup.node,
    startup.home,
    source.releaseRoot,
  ]);
  requireMatch(
    (await realpath(path.dirname(selectionPath))) === path.dirname(selectionPath),
    "Host selection parent is not canonical",
  );
  const selectedRelease = await realpath(selectionPath);
  requireMatch(inside(source.releaseRoot, selectedRelease), "Host selection escaped release root");
  const receiptPath = path.join(selectedRelease, ".installation-source.json");
  custody.capture([selectedRelease, receiptPath]);
  await protectedPaths(
    [
      expected.launcherPath,
      source.releaseRoot,
      selectedRelease,
      receiptPath,
      startup.node,
      config.stateDir,
      startup.home,
      path.dirname(selectionPath),
    ],
    roots,
    ports.uid,
  );
  await assertBootstrapPathsProtected([selectionPath], roots);
  const launcherBytes = await readProtectedDocument(expected.launcherPath);
  const plist = z
    .object({
      Label: z.string(),
      Program: z.string().optional(),
      ProgramArguments: z.array(z.string()),
      EnvironmentVariables: z.record(z.string(), z.string()),
    })
    .parse(
      JSON.parse(
        await ports.command(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", "--", expected.launcherPath],
          COMMAND_LIMITS,
        ),
      ),
    );
  const argv = [startup.node, startup.entrypoint];
  requireMatch(
    plist.Label === expected.serviceLabel &&
      isDeepStrictEqual(plist.ProgramArguments, argv) &&
      (!plist.Program || plist.Program === startup.node) &&
      plist.EnvironmentVariables.PASEO_HOME === startup.home,
    "Host plist does not match configured daemon",
  );
  requireMatch(
    startup.entrypoint ===
      path.join(selectionPath, "packages/server/dist/scripts/supervisor-entrypoint.js"),
    "Unsupported Host launcher arguments",
  );
  const readService = () =>
    ports.command("/bin/launchctl", ["print", hostLaunchdService(config)], COMMAND_LIMITS);
  const service = await readService();
  const supervisorPid = loadedCoordinatorPid(hostLaunchdService(config), service);
  verifyHostRegistration(service, argv, expected.launcherPath, startup.home);
  if (purpose.kind === "initial-migration")
    verifyInitialHostRegistration(service, plist, purpose.precondition);
  const reader = await ports.processes(setup, roots);
  const inspect = async (processId: number) => {
    const { stopped: _stopped, ...observation } = ProcessObservationSchema.extend({
      stopped: z.literal(false),
    }).parse(await reader.inspectRunningProcess(processId));
    return observation;
  };
  const supervisor = await inspect(supervisorPid);
  const worker = await inspect(pid);
  verifyHostProcesses({
    supervisor,
    worker,
    supervisorPid,
    workerPid: pid,
    uid: ports.uid,
    node: startup.node,
    selectedRelease,
    argv,
    purpose,
  });
  const receipt = SourceSchema.parse(
    JSON.parse((await readProtectedDocument(receiptPath)).toString("utf8")),
  );
  if (purpose.kind === "initial-migration")
    requireMatch(
      isDeepStrictEqual(worker, purpose.precondition.worker) &&
        selectedRelease === purpose.precondition.selectedRelease &&
        receipt.sourceCommit === purpose.precondition.sourceCommit,
      "Initial Host source or worker changed",
    );
  requireMatch(
    isDeepStrictEqual(supervisor, await inspect(supervisorPid)) &&
      isDeepStrictEqual(worker, await inspect(pid)) &&
      service === (await readService()) &&
      selectedRelease === (await realpath(selectionPath)) &&
      launcherBytes.equals(await readProtectedDocument(expected.launcherPath)),
    "Host native identity changed during inspection",
  );
  return {
    descriptor: {
      version: 1 as const,
      environment: "host" as const,
      target: "host" as const,
      installationId: config.public.installationId,
      custodyOwnerUid: supervisor.uid,
      installationRoot: await realpath(expected.installationRoot),
      stateDirectory: await realpath(startup.home),
      serviceDomain: hostLaunchdService(config).split("/").slice(0, 2).join("/"),
      serviceLabel: plist.Label,
      launcherPath: expected.launcherPath,
      selectionPath,
    },
    selectedRelease,
    sourceCommit: receipt.sourceCommit,
    supervisor,
    worker,
    async verifyPreviousWorkerExited(previous: z.infer<typeof RuntimeProcessSchema>) {
      RuntimeProcessSchema.parse(previous);
      requireMatch(previous.uid === worker.uid, "Previous worker custody differs");
      // The independently inspected replacement supplies the current boot. PID
      // reuse across a verified boot change cannot preserve the old lifetime.
      if (previous.bootId !== worker.bootId) return;
      await verifyRetainedProcessExited(reader, previous);
    },
  };
}

// Fixed read-only program. Inputs are data, not shell fragments. Never load code
// from the selected guest release to obtain evidence about that release.
export const DEV_DAEMON_INSPECTION_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const input = JSON.parse(process.argv[1]);
function read(file) { const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); try { const b = Buffer.alloc(65537); const n = fs.readSync(fd,b,0,b.length,0); if(n>65536) throw Error('Oversized native evidence'); return b.subarray(0,n).toString('utf8'); } finally { fs.closeSync(fd); } }
function check(ok) { if(!ok) throw Error('Dev native identity differs'); }
const canonical = file => { check(path.isAbsolute(file) && fs.realpathSync(file) === file); return file; };
const hash = args => crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
const bootId = read('/proc/sys/kernel/random/boot_id').trim();
function proc(pid) {
 check(Number.isSafeInteger(pid) && pid>0);
 const stat = read('/proc/'+pid+'/stat'); const fields = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
 check(!['Z','T','t','X'].includes(fields[0]));
 const status = read('/proc/'+pid+'/status');
 const ids = name => { const line=status.match(new RegExp('^'+name+':\\s+([0-9]+)\\s+([0-9]+)\\s+([0-9]+)\\s+([0-9]+)','m')); check(line && line.slice(1).every(v=>v===line[1])); return Number(line[1]); };
 const argv=read('/proc/'+pid+'/cmdline').split('\0').filter(Boolean);
 return { pid,parentPid:Number(fields[1]),uid:ids('Uid'),gid:ids('Gid'),bootId,startIdentity:fields[19],executable:fs.realpathSync('/proc/'+pid+'/exe'),argumentsSha256:hash(argv),argv,env:read('/proc/'+pid+'/environ').split('\0') };
}
const account=os.userInfo(); check(process.getuid()===account.uid && process.getgid()===account.gid);
const home=canonical(account.homedir), state=canonical(input.home), root=canonical(input.releaseRoot);
const marker=JSON.parse(read(path.join(state,'managed-supervisor.json')));
check(marker.version===1 && marker.root===root && marker.link===input.selection);
const sup=proc(marker.pid), worker=proc(input.pid);
const env = name => { const entries=sup.env.filter(s=>s.startsWith(name+'=')); check(entries.length===1); return entries[0].slice(name.length+1); };
const selection=env('PASEO_MANAGED_RELEASE_LINK'); check(selection===marker.link && canonical(path.dirname(selection))===root && env('PASEO_MANAGED_RELEASE_ROOT')===root && env('PASEO_HOME')===state);
const release=fs.realpathSync(selection); check(release.startsWith(root+'/'));
check(sup.uid===account.uid && sup.gid===account.gid && worker.uid===account.uid && worker.gid===account.gid && worker.parentPid===sup.pid && sup.executable===fs.realpathSync(input.node) && worker.executable===sup.executable);
check(sup.argv.length===2 && worker.argv.length===2 && sup.argv[0]===input.node && worker.argv[0]===input.node && worker.argv[1]===path.join(release,'packages/server/dist/server/server/daemon-worker.js'));
const supervisorEntrypoint=canonical(sup.argv[1]); check(supervisorEntrypoint.endsWith('/packages/server/dist/scripts/supervisor-entrypoint.js'));
check(worker.env.includes('PASEO_HOME='+state) && worker.env.includes('PASEO_MANAGED_WORKER=1'));
const receipt=JSON.parse(read(path.join(release,'.installation-source.json')));
check(JSON.stringify(sup)===JSON.stringify(proc(sup.pid)) && JSON.stringify(worker)===JSON.stringify(proc(worker.pid)) && fs.realpathSync(selection)===release);
const clean=({argv,env,...rest})=>rest;
console.log(JSON.stringify({ uid:account.uid,gid:account.gid,home,state,supervisorEntrypoint,selection,release,sourceCommit:receipt.sourceCommit,supervisor:clean(sup),worker:clean(worker) }));
`;

interface DevRegistrationCustody {
  custody: ReturnType<typeof retainCustody>;
  roots: string[];
  startup: z.infer<typeof DevStartupSchema>;
  writableMounts: string[];
}

async function inspectDev(
  config: InstallationConfig,
  expected: Extract<EnrollmentNativeIdentity, { environment: "container" }>,
  setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
  pid: number,
  ports: EnrollmentDaemonInspectionPorts,
  registrationCustody: DevRegistrationCustody,
): Promise<never> {
  const settings = config.containerSourceUpdates;
  requireMatch(
    settings && settings.containerId === setup.containerId && settings.docker === setup.docker,
    "Dev Docker setup is unsupported or changed",
  );
  const result = z
    .strictObject({
      uid: z.number().int().nonnegative(),
      gid: z.number().int().nonnegative(),
      home: z.string().startsWith("/"),
      state: z.string().startsWith("/"),
      supervisorEntrypoint: z.string().startsWith("/"),
      selection: z.string().startsWith("/"),
      release: z.string().startsWith("/"),
      sourceCommit: SourceSchema.shape.sourceCommit,
      supervisor: RuntimeProcessSchema,
      worker: RuntimeProcessSchema,
    })
    .parse(
      JSON.parse(
        await ports.command(
          setup.docker,
          [
            "--host",
            `unix://${setup.socket}`,
            "exec",
            "--env",
            "NODE_OPTIONS=",
            "--env",
            "NODE_PATH=",
            "--user",
            settings.user,
            setup.containerId,
            settings.node,
            "--eval",
            DEV_DAEMON_INSPECTION_SCRIPT,
            JSON.stringify({
              home: settings.home,
              releaseRoot: settings.releaseRoot,
              selection: settings.currentReleaseLink,
              node: settings.node,
              pid,
            }),
          ],
          COMMAND_LIMITS,
        ),
      ),
    );
  requireMatch(
    result.worker.pid === pid &&
      result.worker.parentPid === result.supervisor.pid &&
      result.worker.uid === result.uid &&
      result.supervisor.uid === result.uid &&
      result.worker.gid === result.gid &&
      result.supervisor.gid === result.gid &&
      result.worker.bootId === result.supervisor.bootId &&
      result.selection === settings.currentReleaseLink &&
      result.state === settings.home &&
      inside(settings.releaseRoot, result.release),
    "Dev observed processes or selection differ",
  );
  const retained = SourceSchema.parse(
    readPrivateBootstrapConfiguration(settings.receiptFile, ports.uid),
  );
  requireMatch(
    retained.sourceCommit === result.sourceCommit,
    "Dev source differs from protected receipt",
  );
  requireMatch(
    result.uid === expected.containerUid &&
      result.gid === expected.containerGid &&
      result.home === expected.containerHome &&
      result.state === expected.containerStateDirectory &&
      result.selection === expected.selectionPath,
    "Dev observed account or selection differs from enrollment",
  );
  const reference = config.container.persistentRegistration;
  if (reference) {
    const { custody, roots, startup, writableMounts } = registrationCustody;
    custody.capture([reference.receiptFile]);
    await protectedPaths([reference.receiptFile], roots, ports.uid);
    const receipt = readDevRegistrationBinding({
      bytes: await readProtectedDocument(reference.receiptFile),
      reference,
      config,
      expected,
      startup,
    });
    const plan = config.container.supervisorMaintenance;
    requireMatch(plan, "Dev supervisor maintenance plan is unavailable");
    custody.capture([plan.script, plan.node]);
    await protectedPaths([plan.script, plan.node], roots, ports.uid);
    await readBootstrapPreparedFile({ path: plan.script, sha256: plan.sha256 }, roots);
    const observation = JSON.parse(
      await ports.command(
        setup.docker,
        [
          "--host",
          `unix://${setup.socket}`,
          "exec",
          "--env",
          "NODE_OPTIONS=",
          "--env",
          "NODE_PATH=",
          "--user",
          settings.user,
          setup.containerId,
          settings.node,
          "--eval",
          DEV_REGISTRATION_INSPECTION_SCRIPT,
          JSON.stringify({ receipt, writableMounts, parentPid: result.supervisor.parentPid }),
        ],
        COMMAND_LIMITS,
      ),
    );
    verifyDevRegistrationObservation({
      receipt,
      observation,
      supervisor: result.supervisor,
      selectedRelease: result.release,
    });
    custody.assertCurrent();
    // Matching native files and a protected receipt do not establish what the
    // opaque Factory entry executes. The provisioner must supply that contract.
    throw new Error("Dev opaque Factory startup handoff remains unverified");
  }
  // InstallationConfig pins source selection and one-operation runtime helpers,
  // but no persistent profile launcher registration. Docker's immutable entrypoint
  // plus live supervisor argv do not prove who recreates it after replacement.
  // Never turn the transient executable path into standing identity.
  throw new Error(
    "Dev stable launcher registration is unavailable in protected Host configuration",
  );
}

function verifyHostRegistration(
  service: string,
  argv: string[],
  launcherPath: string,
  home: string,
): void {
  const environments = [...service.matchAll(/^\tenvironment = \{\n([\s\S]*?)^\t\}$/gm)];
  requireMatch(
    environments.length === 1 &&
      environments[0][1].split("\n").filter((line) => line.trim().startsWith("PASEO_HOME => "))
        .length === 1 &&
      environments[0][1].split("\n").some((line) => line.trim() === `PASEO_HOME => ${home}`),
    "Loaded Host environment differs from configured state",
  );
  const args = [...service.matchAll(/^\targuments = \{\n([\s\S]*?)^\t\}$/gm)];
  const programs = [...service.matchAll(/^\tprogram = (.+)$/gm)];
  const paths = [...service.matchAll(/^\tpath = (.+)$/gm)];
  requireMatch(
    args.length === 1 &&
      isDeepStrictEqual(
        args[0][1]
          .trim()
          .split("\n")
          .map((s) => s.trim()),
        argv,
      ) &&
      programs.length === 1 &&
      programs[0][1] === argv[0] &&
      paths.length === 1 &&
      paths[0][1] === launcherPath,
    "Loaded Host registration differs from plist",
  );
}
