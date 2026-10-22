import { createHash } from "node:crypto";
import { endianness } from "node:os";
import { lstat, readdir, readFile, readlink, statfs } from "node:fs/promises";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import {
  ExitedProcessObservationSchema,
  FrozenProcessObservationSchema,
  RunningProcessObservationSchema,
} from "./coordinator-bootstrap-service.js";

type ProcessObservation = z.infer<typeof ProcessObservationSchema>;

const PROC_SUPER_MAGIC = 0x9fa0;
const AT_NULL = 0n;
const AT_CLKTCK = 17n;

/** Fields of /proc/<pid>/stat that bind one process lifetime. `comm` is
 * process-controlled and may contain spaces or parentheses, so fields are read
 * after its last closing parenthesis. */
export interface ProcStat {
  pid: number;
  state: string;
  parentPid: number;
  startTicks: bigint;
}

export function parseProcStat(pid: number, text: string): ProcStat {
  const close = text.lastIndexOf(")");
  if (!text.startsWith(`${pid} (`) || close < 0)
    throw new BootstrapRequestConflict("Process status identity is invalid");
  // Field 3 (state) is the first field after comm; field 22 (starttime) is index 19.
  // PID 1 and kernel threads report parent 0; the observation schema refuses it later.
  const fields = text
    .slice(close + 1)
    .trim()
    .split(" ");
  const [state, parent] = fields;
  const start = fields[19];
  if (
    fields.length < 20 ||
    !state ||
    !/^[A-Za-z]$/.test(state) ||
    !parent ||
    !/^\d+$/.test(parent) ||
    !start ||
    !/^\d+$/.test(start)
  )
    throw new BootstrapRequestConflict("Process status identity is invalid");
  return { pid, state, parentPid: Number(parent), startTicks: BigInt(start) };
}

/** The thread group and all four of real, effective, saved and filesystem UIDs. */
export interface ProcStatus {
  threadGroup: number;
  uids: number[];
}

function statusValues(text: string, key: string): string[] {
  const lines = text.split("\n").filter((line) => line.startsWith(`${key}:`));
  const values = lines[0]
    ?.slice(key.length + 1)
    .trim()
    .split(/\s+/);
  if (lines.length !== 1 || !values?.every((value) => /^\d+$/.test(value)))
    throw new BootstrapRequestConflict("Process status is unavailable");
  return values;
}

export function parseProcStatus(text: string): ProcStatus {
  const threadGroup = statusValues(text, "Tgid");
  const uids = statusValues(text, "Uid");
  if (threadGroup.length !== 1 || uids.length !== 4)
    throw new BootstrapRequestConflict("Process status is unavailable");
  return { threadGroup: Number(threadGroup[0]), uids: uids.map(Number) };
}

/** Matches the macOS inspector: compact JSON of strictly decoded argv. */
export function procArgumentsDigest(cmdline: Buffer): string {
  if (cmdline.length === 0 || cmdline[cmdline.length - 1] !== 0)
    throw new BootstrapRequestConflict("Process arguments are incomplete");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const args: string[] = [];
  for (let start = 0; start < cmdline.length; ) {
    const end = cmdline.indexOf(0, start);
    args.push(decoder.decode(cmdline.subarray(start, end)));
    start = end + 1;
  }
  return createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

/** Clock ticks since boot become boot-relative `seconds:microseconds`, the
 * birth format compared by retained-process recovery. Compare only within one
 * boot ID; unlike macOS this is not wall-clock time. */
export function startIdentityFromTicks(ticks: bigint, ticksPerSecond: bigint): string {
  if (ticksPerSecond <= 0n || 1_000_000n % ticksPerSecond !== 0n)
    throw new BootstrapRequestConflict("Kernel clock tick rate is unsupported");
  const micros = (ticks % ticksPerSecond) * (1_000_000n / ticksPerSecond);
  return `${ticks / ticksPerSecond}:${micros}`;
}

/** Parses a 64-bit little-endian auxiliary vector; see `readClockTicks`. */
export function clockTicksFromAuxv(auxv: Buffer): bigint {
  if (endianness() !== "LE" || auxv.length % 16 !== 0)
    throw new BootstrapRequestConflict("Kernel auxiliary vector is unsupported");
  for (let offset = 0; offset < auxv.length; offset += 16) {
    const type = auxv.readBigUInt64LE(offset);
    if (type === AT_NULL) break;
    if (type === AT_CLKTCK) return auxv.readBigUInt64LE(offset + 8);
  }
  throw new BootstrapRequestConflict("Kernel clock tick rate is unavailable");
}

const SIXTY_FOUR_BIT_ARCHES = new Set(["x64", "arm64", "riscv64", "loong64", "ppc64"]);

/** A 32-bit vector can be a multiple of 16 bytes, so the word size comes from
 * the architecture, never from the vector's length. */
async function readClockTicks(): Promise<bigint> {
  if (!SIXTY_FOUR_BIT_ARCHES.has(process.arch))
    throw new BootstrapRequestConflict("Kernel auxiliary vector is unsupported");
  return clockTicksFromAuxv(await readFile("/proc/self/auxv"));
}

/** Hidden PIDs make absence meaningless, and a procfs mounted for another PID
 * namespace numbers processes differently. Only an unrestricted procfs of the
 * observer's own PID namespace is accepted. A nested observer still fails
 * closed later: the system manager's user-manager PID would not match. */
async function requireOwnProcfs(): Promise<void> {
  if ((await statfs("/proc")).type !== PROC_SUPER_MAGIC)
    throw new BootstrapRequestConflict("Process inspection requires procfs");
  // mountinfo: "<id> <parent> <dev> <root> <mountpoint> <opts> [tags] - <type> <source> <superopts>".
  // The last mount at /proc is the one path lookups resolve through.
  const mount = (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .map((line) => line.split(" "))
    .findLast((fields) => fields[4] === "/proc");
  const separator = mount?.indexOf("-") ?? -1;
  const fstype = mount?.[separator + 1];
  const superOptions = mount?.[separator + 3]?.split(",");
  if (!mount || separator < 6 || fstype !== "proc" || !superOptions)
    throw new BootstrapRequestConflict("Process inspection requires procfs at /proc");
  const hidden = superOptions.some(
    (option) => option.startsWith("hidepid=") && !["hidepid=0", "hidepid=off"].includes(option),
  );
  const subset = superOptions.some((option) => option.startsWith("subset="));
  if (hidden || subset)
    throw new BootstrapRequestConflict("Process inspection requires an unrestricted procfs");
  const nested = (await readFile("/proc/self/status", "utf8"))
    .split("\n")
    .find((line) => line.startsWith("NSpid:"));
  if (!nested || nested.slice(6).trim().split(/\s+/).length !== 1)
    throw new BootstrapRequestConflict(
      "Process inspection requires its own PID namespace's procfs",
    );
}

async function readStat(pid: number): Promise<ProcStat> {
  return parseProcStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
}

async function readChildren(pid: number): Promise<number[]> {
  // A stopped process cannot create or reap threads, so the task list and
  // each thread's children file describe one complete inventory.
  const children: number[] = [];
  for (const task of await readdir(`/proc/${pid}/task`)) {
    const text = await readFile(`/proc/${pid}/task/${task}/children`, "utf8");
    for (const value of text.trim().split(" ").filter(Boolean)) {
      if (!/^[1-9]\d*$/.test(value))
        throw new BootstrapRequestConflict("Process children are invalid");
      children.push(Number(value));
    }
  }
  if (new Set(children).size !== children.length)
    throw new BootstrapRequestConflict("Process children are invalid");
  return children.sort((a, b) => a - b);
}

type InspectionMode = "identity" | "running" | "stopped";

interface ProcessInspection {
  observation: ProcessObservation;
  children: number[] | null;
  cgroup: string;
}

function sameLifetime(a: ProcStat, b: ProcStat): boolean {
  return a.pid === b.pid && a.parentPid === b.parentPid && a.startTicks === b.startTicks;
}

function requireProcessState(stat: ProcStat, mode: InspectionMode): void {
  if (mode === "stopped" && stat.state !== "T")
    throw new BootstrapRequestConflict("Process is not stopped");
  if (mode === "running" && !["R", "S", "D"].includes(stat.state))
    throw new BootstrapRequestConflict("Process is not running");
}

/** The guest may share the Host uid, so the namespaces, not the owner,
 * establish that the executable path names a Host file. */
async function requireInspectable(input: {
  pid: number;
  stat: ProcStat;
  mode: InspectionMode;
  uid: number;
}): Promise<void> {
  const { pid, stat, mode, uid } = input;
  const status = parseProcStatus(await readFile(`/proc/${pid}/status`, "utf8"));
  // /proc/<tid> resolves for every thread; only a thread-group leader is a process.
  if (status.threadGroup !== pid)
    throw new BootstrapRequestConflict("Process identifier names a thread");
  if (!status.uids.every((value) => value === uid))
    throw new BootstrapRequestConflict("Process owner does not match Host");
  requireProcessState(stat, mode);
  for (const namespace of ["pid", "mnt"]) {
    const [own, target] = await Promise.all([
      readlink(`/proc/self/ns/${namespace}`),
      readlink(`/proc/${pid}/ns/${namespace}`),
    ]);
    if (own !== target) throw new BootstrapRequestConflict("Process belongs to another namespace");
  }
}

async function readExecutable(pid: number): Promise<string> {
  const executable = await readlink(`/proc/${pid}/exe`);
  if (!executable.startsWith("/") || executable.endsWith(" (deleted)"))
    throw new BootstrapRequestConflict("Process executable is unavailable");
  return executable;
}

export interface LinuxProcessReader {
  readStat(pid: number): Promise<ProcStat>;
  requireInspectable: typeof requireInspectable;
  readChildren(pid: number): Promise<number[]>;
  readArguments(pid: number): Promise<Buffer>;
  readExecutable(pid: number): Promise<string>;
  readCgroup(pid: number): Promise<string>;
}

const nativeProcessReader: LinuxProcessReader = {
  readStat,
  requireInspectable,
  readChildren,
  readArguments: (pid) => readFile(`/proc/${pid}/cmdline`),
  readExecutable,
  readCgroup: (pid) => readFile(`/proc/${pid}/cgroup`, "utf8"),
};

async function inspect(pid: number, mode: InspectionMode): Promise<ProcessInspection> {
  z.number().int().positive().parse(pid);
  if (process.platform !== "linux" || !process.getuid)
    throw new BootstrapRequestConflict("Native Linux process inspection required");
  const uid = process.getuid();
  await requireOwnProcfs();
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const ticksPerSecond = await readClockTicks();
    return await inspectLinuxProcessSnapshot({
      pid,
      mode,
      uid,
      bootId,
      ticksPerSecond,
      reader: nativeProcessReader,
    });
  } catch (error) {
    if (error instanceof BootstrapRequestConflict) throw error;
    throw new BootstrapRequestConflict("Coordinator process identity could not be verified");
  }
}

/** Repeated procfs reads must agree on identity and the requested final state. */
export async function inspectLinuxProcessSnapshot(input: {
  pid: number;
  mode: InspectionMode;
  uid: number;
  bootId: string;
  ticksPerSecond: bigint;
  reader: LinuxProcessReader;
}): Promise<ProcessInspection> {
  const { pid, mode, uid, bootId, ticksPerSecond, reader } = input;
  try {
    const before = await reader.readStat(pid);
    await reader.requireInspectable({ pid, stat: before, mode, uid });
    const children = mode === "stopped" ? await reader.readChildren(pid) : null;
    const digest = procArgumentsDigest(await reader.readArguments(pid));
    const executable = await reader.readExecutable(pid);
    const cgroup = await reader.readCgroup(pid);
    // exec changes the executable and argv without changing PID or birth time.
    if (
      procArgumentsDigest(await reader.readArguments(pid)) !== digest ||
      (await reader.readExecutable(pid)) !== executable ||
      (await reader.readCgroup(pid)) !== cgroup ||
      !sameLifetime(await reader.readStat(pid), before)
    )
      throw new BootstrapRequestConflict("Process identity changed during inspection");
    if (children && (await reader.readChildren(pid)).join(",") !== children.join(","))
      throw new BootstrapRequestConflict("Process children changed during inspection");
    const after = await reader.readStat(pid);
    if (!sameLifetime(after, before))
      throw new BootstrapRequestConflict("Process identity changed after child inspection");
    requireProcessState(after, mode);
    const observation = ProcessObservationSchema.parse({
      pid,
      parentPid: before.parentPid,
      uid,
      bootId,
      startIdentity: startIdentityFromTicks(before.startTicks, ticksPerSecond),
      argumentsSha256: digest,
      executable,
    });
    return { observation, children, cgroup };
  } catch (error) {
    // Do not expose argv, paths or raw system errors from another process.
    if (error instanceof BootstrapRequestConflict) throw error;
    throw new BootstrapRequestConflict("Coordinator process identity could not be verified");
  }
}

export async function inspectLinuxProcess(pid: number): Promise<ProcessObservation> {
  return (await inspect(pid, "identity")).observation;
}

export async function inspectRunningLinuxProcess(
  pid: number,
): Promise<z.infer<typeof RunningProcessObservationSchema>> {
  const { observation } = await inspect(pid, "running");
  return RunningProcessObservationSchema.parse({ ...observation, stopped: false });
}

export async function inspectStoppedLinuxProcess(
  pid: number,
): Promise<z.infer<typeof FrozenProcessObservationSchema>> {
  const { observation, children } = await inspect(pid, "stopped");
  return FrozenProcessObservationSchema.parse({
    ...observation,
    stopped: true,
    childPids: children,
  });
}

/** The cgroup is read between two lifetime observations of the same PID. */
export async function inspectLinuxProcessCgroup(pid: number): Promise<{
  observation: ProcessObservation;
  cgroup: string;
}> {
  const { observation, cgroup } = await inspect(pid, "identity");
  return { observation, cgroup };
}

/** Only absence of the PID directory in an unrestricted procfs proves exit.
 * A zombie keeps its directory and is not yet exited. */
export async function verifyLinuxProcessExited(pid: number): Promise<void> {
  z.number().int().positive().parse(pid);
  if (process.platform !== "linux")
    throw new BootstrapRequestConflict("Native Linux process inspection required");
  await requireOwnProcfs();
  try {
    await lstat(`/proc/${pid}`);
  } catch (error) {
    const missing = z.object({ code: z.literal("ENOENT") }).safeParse(error);
    if (missing.success) {
      ExitedProcessObservationSchema.parse({ pid, exited: true });
      return;
    }
  }
  throw new BootstrapRequestConflict("Process exit is not proven");
}
