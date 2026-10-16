import { createHash } from "node:crypto";
import { DaemonMaintenanceProcessSchema as RuntimeProcessSchema } from "@getpaseo/protocol/maintenance-interruption";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import type { InstallationConfig } from "../config.js";
import { connectInstallationDaemon } from "../daemon.js";
import {
  BootstrapAdmissionSetupSchema,
  bootstrapWritableMountRoots,
  readPrivateBootstrapConfiguration,
} from "../coordinator-bootstrap-host.js";
import {
  assertBootstrapPathsProtected,
  readProtectedDocument,
} from "../coordinator-bootstrap-artifact.js";
import {
  createNativeBootstrapServiceReader,
  loadedCoordinatorPid,
} from "../coordinator-bootstrap-service.js";
import { ProcessObservationSchema } from "../coordinator-bootstrap-process.js";
import {
  EnrollmentNativeIdentitySchema,
  enrollmentNativeIdentityDigest,
  type EnrollmentNativeIdentity,
} from "./native-identity.js";

const execute = promisify(execFile);
const COMMAND_LIMITS: { timeout: number; maxBuffer: number; env: { PATH: string } } = {
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
  env: { PATH: "/usr/bin:/bin" },
};
const SourceSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) });
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
  selectedRelease: string;
  sourceCommit: string;
  supervisor: z.infer<typeof RuntimeProcessSchema>;
  worker: z.infer<typeof RuntimeProcessSchema>;
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
  }>;
  daemon(
    config: InstallationConfig,
    kind: "host" | "container",
  ): Promise<{ serverId: string; pid: number; workerInstanceId?: string }>;
  now(): number;
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
        };
      }
      return { serverId: info!.serverId, pid: status.pid };
    } finally {
      await client.close();
    }
  },
  now: Date.now,
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
  const started = ports.now();
  const command = ports.command.bind(ports);
  ports = {
    ...ports,
    command: async (file, args, limits) => {
      const remaining = 60_000 - (ports.now() - started);
      requireMatch(remaining > 0, "Native observation exceeded freshness deadline");
      return command(file, args, { ...limits, timeout: Math.min(limits.timeout, remaining) });
    },
  };
  const custody = retainCustody();
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
  requireMatch(
    isDeepStrictEqual(
      readPrivateBootstrapConfiguration(setup.configurationFile, ports.uid),
      config,
    ),
    "Protected installation configuration differs",
  );
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
      ? await inspectHost(config, expected, setup, mounts.roots, daemon.pid, ports, custody)
      : await inspectDev(config, expected, setup, daemon.pid, ports);
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
        readPrivateBootstrapConfiguration(setup.configurationFile, ports.uid),
      ),
    "Native configuration changed during inspection",
  );
  const finalDaemon = await ports.daemon(config, kind);
  requireMatch(isDeepStrictEqual(daemon, finalDaemon), "Daemon changed during inspection");
  requireMatch(ports.now() - started <= 60_000, "Native observation exceeded freshness deadline");
  const descriptor = EnrollmentNativeIdentitySchema.parse(observed.descriptor);
  requireMatch(
    enrollmentNativeIdentityDigest(descriptor) === enrollmentNativeIdentityDigest(expected),
    "Observed native identity differs from enrollment",
  );
  custody.assertCurrent();
  return {
    ...observed,
    assertCurrent: custody.assertCurrent,
    descriptor,
    identitySha256: enrollmentNativeIdentityDigest(descriptor),
    writableMountRoots: await Promise.all(mounts.roots.map((root) => realpath(root))),
    custodyStateDirectory: await realpath(config.stateDir),
    serverId: daemon.serverId,
    ...(daemon.workerInstanceId ? { workerInstanceId: daemon.workerInstanceId } : {}),
    observedAt: new Date(ports.now()).toISOString(),
  };
}

async function inspectHost(
  config: InstallationConfig,
  expected: Extract<EnrollmentNativeIdentity, { environment: "host" }>,
  setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
  roots: string[],
  pid: number,
  ports: EnrollmentDaemonInspectionPorts,
  custody: ReturnType<typeof retainCustody>,
) {
  const source = config.sourceUpdates;
  const startup = config.host.startupValidation;
  requireMatch(source && startup, "Host selected-source inspection is unsupported");
  requireMatch(
    config.host.launchdService === `${expected.serviceDomain}/${expected.serviceLabel}`,
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
    ports.command("/bin/launchctl", ["print", config.host.launchdService], COMMAND_LIMITS);
  const service = await readService();
  const supervisorPid = loadedCoordinatorPid(config.host.launchdService, service);
  verifyHostRegistration(service, argv, expected.launcherPath, startup.home);
  const reader = await ports.processes(setup, roots);
  const inspect = async (processId: number) => {
    const { stopped: _stopped, ...observation } = ProcessObservationSchema.extend({
      stopped: z.literal(false),
    }).parse(await reader.inspectRunningProcess(processId));
    return observation;
  };
  const supervisor = await inspect(supervisorPid);
  const worker = await inspect(pid);
  requireMatch(
    supervisor.pid === supervisorPid &&
      supervisor.uid === ports.uid &&
      supervisor.parentPid === 1 &&
      supervisor.executable === startup.node &&
      supervisor.argumentsSha256 === sha(argv),
    "Host supervisor does not match registration",
  );
  requireMatch(
    worker.pid === pid &&
      worker.uid === ports.uid &&
      worker.parentPid === supervisorPid &&
      worker.bootId === supervisor.bootId &&
      worker.executable === startup.node &&
      worker.argumentsSha256 ===
        sha([
          startup.node,
          path.join(selectedRelease, "packages/server/dist/server/server/daemon-worker.js"),
        ]),
    "Host worker differs from selected source",
  );
  const receipt = SourceSchema.parse(
    JSON.parse((await readProtectedDocument(receiptPath)).toString("utf8")),
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
      serviceDomain: config.host.launchdService.split("/").slice(0, 2).join("/"),
      serviceLabel: plist.Label,
      launcherPath: expected.launcherPath,
      selectionPath,
    },
    selectedRelease,
    sourceCommit: receipt.sourceCommit,
    supervisor,
    worker,
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

async function inspectDev(
  config: InstallationConfig,
  expected: Extract<EnrollmentNativeIdentity, { environment: "container" }>,
  setup: z.infer<typeof BootstrapAdmissionSetupSchema>,
  pid: number,
  ports: EnrollmentDaemonInspectionPorts,
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
