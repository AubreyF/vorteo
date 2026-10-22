import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { assertBootstrapPathsProtected } from "./coordinator-bootstrap-artifact.js";
import {
  inspectLinuxProcess,
  inspectLinuxProcessCgroup,
  inspectRunningLinuxProcess,
  inspectStoppedLinuxProcess,
  verifyLinuxProcessExited,
} from "./coordinator-bootstrap-linux-process.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import type { NativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";

type ProcessObservation = z.infer<typeof ProcessObservationSchema>;

/** Linux counterpart of `gui/<uid>/<label>`: the owner account's user manager
 * and one coordinator unit. Plans cannot carry this form until the protocol
 * accepts it; see docs/plans/execution-environments/linux-host.md. */
const SystemdBootstrapServiceSchema = z
  .string()
  .regex(
    /^systemd-user\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+\.installation(?:-recovery-[a-f0-9-]{36})?\.service$/,
  );

export interface SystemdService {
  uid: number;
  unit: string;
}

export function parseSystemdService(service: string): SystemdService {
  const [, uid, unit] = SystemdBootstrapServiceSchema.parse(service).split("/");
  if (!uid || !unit) throw new BootstrapRequestConflict("Coordinator service identity is invalid");
  return { uid: Number(uid), unit };
}

const ExecCommandSchema = z.strictObject({
  path: z.string().startsWith("/"),
  argv: z.array(z.string()).min(1),
});

/** Canonical `readService` output: typed D-Bus properties of one unit, read
 * from the user-manager connection that the system manager vouches for. */
export const SystemdServiceRecordSchema = z.strictObject({
  version: z.literal(1),
  service: SystemdBootstrapServiceSchema,
  managerPid: z.number().int().positive(),
  busOwner: z.string().regex(/^:\d+\.\d+$/),
  id: z.string(),
  loadState: z.string(),
  activeState: z.string(),
  subState: z.string(),
  fragmentPath: z.string(),
  dropInPaths: z.array(z.string()),
  needDaemonReload: z.boolean(),
  type: z.string(),
  notifyAccess: z.string(),
  mainPid: z.number().int().nonnegative(),
  controlGroup: z.string(),
  execStart: z.array(ExecCommandSchema),
});
export type SystemdServiceRecord = z.infer<typeof SystemdServiceRecordSchema>;

export function parseSystemdServiceRecord(service: string, output: string): SystemdServiceRecord {
  const { unit } = parseSystemdService(service);
  let record: SystemdServiceRecord;
  try {
    record = SystemdServiceRecordSchema.parse(JSON.parse(output));
  } catch {
    throw new BootstrapRequestConflict("Loaded coordinator service identity does not match");
  }
  if (record.service !== service || record.id !== unit)
    throw new BootstrapRequestConflict("Loaded coordinator service identity does not match");
  return record;
}

/** The manager's own main-process record, never a process found in the cgroup. */
export function systemdLoadedPid(service: string, output: string): number {
  const record = parseSystemdServiceRecord(service, output);
  const running =
    record.loadState === "loaded" &&
    record.activeState === "active" &&
    record.subState === "running" &&
    record.mainPid > 0;
  if (!running) throw new BootstrapRequestConflict("Loaded coordinator PID is missing");
  return record.mainPid;
}

/** A stopped unit has no process to inspect. Bind its loaded command before
 * removing it; the unit file on disk alone does not prove loaded identity. */
export function isStoppedSystemdCandidate(input: {
  service: string;
  output: string;
  expectedArguments: readonly string[];
}): boolean {
  const record = parseSystemdServiceRecord(input.service, input.output);
  if (record.mainPid !== 0) return false;
  const [command] = record.execStart;
  const matches =
    record.loadState === "loaded" &&
    ["inactive", "failed"].includes(record.activeState) &&
    record.dropInPaths.length === 0 &&
    !record.needDaemonReload &&
    record.execStart.length === 1 &&
    command?.path === input.expectedArguments[0] &&
    isDeepStrictEqual(command?.argv, input.expectedArguments);
  if (!matches)
    throw new BootstrapRequestConflict("Stopped coordinator does not match approved candidate");
  return true;
}

/** Replaces the macOS `parentPid === 1` check. Membership of the unit's cgroup
 * alone is not proof: the user-manager subtree is delegated to the account, so
 * any process already inside it can migrate. The manager-recorded main PID and
 * the manager as parent bind the process the manager itself started. */
export function verifySystemdServiceOwnership(input: {
  service: string;
  output: string;
  process: unknown;
  cgroup: string;
  hostUid: number;
}): void {
  const { uid, unit } = parseSystemdService(input.service);
  const record = parseSystemdServiceRecord(input.service, input.output);
  const pid = systemdLoadedPid(input.service, input.output);
  const observation = ProcessObservationSchema.parse(input.process);
  const managerTree = `/user.slice/user-${uid}.slice/user@${uid}.service/`;
  const ownedByManager =
    uid === input.hostUid &&
    observation.pid === pid &&
    observation.uid === input.hostUid &&
    observation.parentPid === record.managerPid &&
    ["simple", "exec"].includes(record.type) &&
    record.notifyAccess === "none";
  const inUnitCgroup =
    record.controlGroup.startsWith(managerTree) &&
    record.controlGroup.endsWith(`/${unit}`) &&
    input.cgroup === `0::${record.controlGroup}\n`;
  if (!ownedByManager || !inUnitCgroup)
    throw new BootstrapRequestConflict("Coordinator is not owned by the Host launch service");
}

export type SystemdTool = "busctl" | "systemctl";

export class SystemdCommandFailure extends Error {
  constructor(
    readonly tool: SystemdTool,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${tool} failed`);
    this.name = "SystemdCommandFailure";
  }
}

export interface SystemdCommandRunner {
  run(tool: SystemdTool, args: readonly string[]): Promise<string>;
}

export interface LinuxProcessInspector {
  inspectProcess(pid: number): Promise<ProcessObservation>;
  inspectRunningProcess: NativeBootstrapServiceReader["inspectRunningProcess"];
  inspectStoppedProcess: NativeBootstrapServiceReader["inspectStoppedProcess"];
  verifyProcessExited(pid: number): Promise<void>;
  inspectProcessCgroup(pid: number): Promise<{ observation: ProcessObservation; cgroup: string }>;
}

/** No audit-token equivalent exists on Linux (see the plan), so this reader
 * cannot back the watchdog or claimed recovery yet. */
export interface SystemdBootstrapServiceReader extends Omit<
  NativeBootstrapServiceReader,
  "inspectAuditedProcess"
> {
  verifyServiceOwnership(service: string, pid: number): Promise<ProcessObservation>;
}

/** Command, bus and schema failures never escape with raw output; callers
 * branch only on `BootstrapRequestConflict`. */
async function guarded<T>(refusal: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BootstrapRequestConflict) throw error;
    throw new BootstrapRequestConflict(refusal);
  }
}

function busJson<T extends z.ZodType>(signature: string, data: T, output: string): z.infer<T> {
  const envelope = z
    .strictObject({ type: z.literal(signature), data: z.unknown() })
    .parse(JSON.parse(output));
  return data.parse(envelope.data);
}

const UnitPathSchema = z.string().regex(/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/);

const ExecStartSchema = z.array(
  z.tuple([
    z.string(),
    z.array(z.string()),
    z.boolean(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
);

export function createSystemdBootstrapServiceReader(input: {
  uid: number;
  runner: SystemdCommandRunner;
  processes: LinuxProcessInspector;
}): SystemdBootstrapServiceReader {
  const { uid, runner, processes } = input;
  const busctl = (args: readonly string[]) =>
    runner.run("busctl", ["--user", "--json=short", "--no-pager", ...args]);

  function account(service: string): SystemdService {
    const parsed = parseSystemdService(service);
    if (parsed.uid !== uid)
      throw new BootstrapRequestConflict("Coordinator service belongs to another Host account");
    return parsed;
  }

  /** The system manager names the account's user manager; the user bus must
   * attribute `org.freedesktop.systemd1` to that PID. Reads then address the
   * unique connection name, which the broker never reassigns. */
  async function pinManager(): Promise<{ owner: string; managerPid: number }> {
    const show = await runner.run("systemctl", [
      "show",
      `user@${uid}.service`,
      "--property=MainPID",
      "--property=ActiveState",
      "--no-pager",
    ]);
    const lines = show.trimEnd().split("\n").sort();
    const [active, main] = lines;
    const managerPid = Number(main?.slice("MainPID=".length));
    if (
      lines.length !== 2 ||
      active !== "ActiveState=active" ||
      !main?.startsWith("MainPID=") ||
      !Number.isSafeInteger(managerPid) ||
      managerPid <= 0
    )
      throw new BootstrapRequestConflict("Host user manager is unavailable");
    const [owner] = busJson(
      "s",
      z.tuple([z.string().regex(/^:\d+\.\d+$/)]),
      await busctl([
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetNameOwner",
        "s",
        "org.freedesktop.systemd1",
      ]),
    );
    const [peer] = busJson(
      "u",
      z.tuple([z.number().int().positive()]),
      await busctl([
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetConnectionUnixProcessID",
        "s",
        owner,
      ]),
    );
    if (peer !== managerPid)
      throw new BootstrapRequestConflict("Host user bus is not served by the user manager");
    return { owner, managerPid };
  }

  async function requireSameManager(pinned: { owner: string; managerPid: number }) {
    if (!isDeepStrictEqual(await pinManager(), pinned))
      throw new BootstrapRequestConflict("Host user manager changed during inspection");
  }

  async function unitPath(owner: string, unit: string): Promise<string> {
    const output = await busctl([
      "call",
      owner,
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "GetUnit",
      "s",
      unit,
    ]);
    const [unitObject] = busJson("o", z.tuple([UnitPathSchema]), output);
    return unitObject;
  }

  async function properties(
    owner: string,
    unitObject: string,
    iface: string,
    names: readonly string[],
  ): Promise<string[]> {
    const output = await busctl(["get-property", owner, unitObject, iface, ...names]);
    const lines = output.trimEnd().split("\n");
    if (lines.length !== names.length)
      throw new BootstrapRequestConflict("Coordinator service properties are incomplete");
    return lines;
  }

  async function readRecord(service: string): Promise<SystemdServiceRecord> {
    const { unit } = account(service);
    const pinned = await pinManager();
    const unitObject = await unitPath(pinned.owner, unit);
    const [id, loadState, activeState, subState, fragmentPath, dropInPaths, needDaemonReload] =
      await properties(pinned.owner, unitObject, "org.freedesktop.systemd1.Unit", [
        "Id",
        "LoadState",
        "ActiveState",
        "SubState",
        "FragmentPath",
        "DropInPaths",
        "NeedDaemonReload",
      ]);
    const [type, notifyAccess, mainPid, controlGroup, execStart] = await properties(
      pinned.owner,
      unitObject,
      "org.freedesktop.systemd1.Service",
      ["Type", "NotifyAccess", "MainPID", "ControlGroup", "ExecStart"],
    );
    const text = (line: string | undefined) => busJson("s", z.string(), line ?? "");
    const record = SystemdServiceRecordSchema.parse({
      version: 1,
      service,
      managerPid: pinned.managerPid,
      busOwner: pinned.owner,
      id: text(id),
      loadState: text(loadState),
      activeState: text(activeState),
      subState: text(subState),
      fragmentPath: text(fragmentPath),
      dropInPaths: busJson("as", z.array(z.string()), dropInPaths ?? ""),
      needDaemonReload: busJson("b", z.boolean(), needDaemonReload ?? ""),
      type: text(type),
      notifyAccess: text(notifyAccess),
      mainPid: busJson("u", z.number().int().nonnegative(), mainPid ?? ""),
      controlGroup: text(controlGroup),
      execStart: busJson("a(sasbttttuii)", ExecStartSchema, execStart ?? "").map(
        ([commandPath, argv]) => ({ path: commandPath, argv }),
      ),
    });
    await requireSameManager(pinned);
    return record;
  }

  async function verifyAbsent(service: string): Promise<void> {
    const { unit } = account(service);
    const pinned = await pinManager();
    const missing = `Call failed: Unit ${unit} not loaded.`;
    let unitObject: string;
    try {
      unitObject = await unitPath(pinned.owner, unit);
    } catch (error) {
      const notLoaded =
        error instanceof SystemdCommandFailure &&
        error.exitCode === 1 &&
        error.stderr.trim() === missing;
      if (!notLoaded)
        throw new BootstrapRequestConflict("Coordinator service absence could not be verified");
      await requireSameManager(pinned);
      return;
    }
    // A unit object may linger after a lookup; only a not-found, inactive one is absent.
    const [loadState, activeState] = await properties(
      pinned.owner,
      unitObject,
      "org.freedesktop.systemd1.Unit",
      ["LoadState", "ActiveState"],
    );
    await requireSameManager(pinned);
    if (
      busJson("s", z.string(), loadState ?? "") !== "not-found" ||
      busJson("s", z.string(), activeState ?? "") !== "inactive"
    )
      throw new BootstrapRequestConflict("Coordinator service is still loaded");
  }

  async function verifyOwnership(service: string, pid: number): Promise<ProcessObservation> {
    account(service);
    const before = JSON.stringify(await readRecord(service));
    const { observation, cgroup } = await processes.inspectProcessCgroup(pid);
    const output = JSON.stringify(await readRecord(service));
    if (before !== output)
      throw new BootstrapRequestConflict("Coordinator service changed during verification");
    verifySystemdServiceOwnership({
      service,
      output,
      process: observation,
      cgroup,
      hostUid: uid,
    });
    return observation;
  }

  return {
    readService(service) {
      return guarded("Coordinator service could not be read", async () =>
        JSON.stringify(await readRecord(service)),
      );
    },
    verifyServiceAbsent(service) {
      return guarded("Coordinator service absence could not be verified", () =>
        verifyAbsent(service),
      );
    },
    verifyServiceOwnership(service, pid) {
      return guarded("Coordinator service ownership could not be verified", () =>
        verifyOwnership(service, pid),
      );
    },
    inspectProcess: (pid) => processes.inspectProcess(pid),
    inspectRunningProcess: (pid) => processes.inspectRunningProcess(pid),
    inspectStoppedProcess: (pid) => processes.inspectStoppedProcess(pid),
    verifyProcessExited: (pid) => processes.verifyProcessExited(pid),
  };
}

const TOOLS: Record<SystemdTool, string> = {
  busctl: "/usr/bin/busctl",
  systemctl: "/usr/bin/systemctl",
};

/** Linux has no SIP. A tool is trusted only as a canonical root-owned file
 * whose every ancestor is root-owned and writable by no group or other. */
export async function assertRootOwnedExecutable(file: string): Promise<void> {
  if ((await realpath(file)) !== file)
    throw new BootstrapRequestConflict("Host tool requires its canonical path");
  const info = await lstat(file);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0)
    throw new BootstrapRequestConflict("Host tool must be a protected root-owned executable");
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const ancestor = await lstat(directory);
    if (!ancestor.isDirectory() || ancestor.uid !== 0 || (ancestor.mode & 0o022) !== 0)
      throw new BootstrapRequestConflict("Host tool directory must be protected and root-owned");
    if (directory === "/") return;
  }
}

/** The user bus socket lives in the account's private runtime directory. */
export async function assertPrivateRuntimeDirectory(input: {
  directory: string;
  uid: number;
  writableMountRoots: readonly string[];
}): Promise<void> {
  const { directory, uid, writableMountRoots } = input;
  // Guest processes may share the Host uid, so mode bits alone do not protect the bus.
  await assertBootstrapPathsProtected([directory], writableMountRoots);
  if ((await realpath(directory)) !== directory)
    throw new BootstrapRequestConflict("Host runtime directory requires its canonical path");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Host runtime directory must be private to the account");
  const parent = await lstat(path.dirname(directory));
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0)
    throw new BootstrapRequestConflict("Host runtime root must be protected and root-owned");
}

export async function createHostSystemdCommandRunner(input: {
  uid: number;
  writableMountRoots: readonly string[];
}): Promise<SystemdCommandRunner> {
  const runtimeDirectory = `/run/user/${input.uid}`;
  for (const tool of Object.values(TOOLS)) await assertRootOwnedExecutable(tool);
  await assertBootstrapPathsProtected(Object.values(TOOLS), input.writableMountRoots);
  await assertPrivateRuntimeDirectory({
    directory: runtimeDirectory,
    uid: input.uid,
    writableMountRoots: input.writableMountRoots,
  });
  // No inherited bus address: busctl --user resolves $XDG_RUNTIME_DIR/bus.
  // LC_ALL=C keeps the absence message exact.
  const env = { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: runtimeDirectory, LC_ALL: "C" };
  return {
    run(tool, args) {
      return new Promise((resolve, reject) => {
        execFile(
          TOOLS[tool],
          [...args],
          { env, timeout: 10_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            if (!error) return resolve(stdout);
            const exitCode = typeof error.code === "number" ? error.code : null;
            reject(new SystemdCommandFailure(tool, exitCode, stderr));
          },
        );
      });
    },
  };
}

/** Linux counterpart of `createNativeBootstrapServiceReader`. Nothing selects
 * it yet; wiring needs the protocol and service-record changes in the plan. */
export async function createHostSystemdBootstrapServiceReader(input: {
  writableMountRoots: readonly string[];
}): Promise<SystemdBootstrapServiceReader> {
  if (process.platform !== "linux" || !process.getuid)
    throw new BootstrapRequestConflict("Coordinator inspection requires native Linux Host");
  const uid = process.getuid();
  return createSystemdBootstrapServiceReader({
    uid,
    runner: await createHostSystemdCommandRunner({
      uid,
      writableMountRoots: input.writableMountRoots,
    }),
    processes: {
      inspectProcess: inspectLinuxProcess,
      inspectRunningProcess: inspectRunningLinuxProcess,
      inspectStoppedProcess: inspectStoppedLinuxProcess,
      verifyProcessExited: verifyLinuxProcessExited,
      inspectProcessCgroup: inspectLinuxProcessCgroup,
    },
  });
}
