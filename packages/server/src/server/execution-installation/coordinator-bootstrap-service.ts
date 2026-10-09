import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { promisify, isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  assertBootstrapPathsProtected,
  readBootstrapPreparedFile,
} from "./coordinator-bootstrap-artifact.js";

const execute = promisify(execFile);

const ProcessObservationSchema = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  bootId: z.string().uuid(),
  startIdentity: z.string().regex(/^\d+:\d+$/),
  argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.string().startsWith("/"),
});

const RunningProcessObservationSchema = ProcessObservationSchema.extend({
  stopped: z.literal(false),
});
const ExitedProcessObservationSchema = z.strictObject({
  pid: z.number().int().positive(),
  exited: z.literal(true),
});

const FrozenProcessObservationSchema = ProcessObservationSchema.extend({
  stopped: z.literal(true),
  childPids: z
    .array(z.number().int().positive())
    .refine((pids) => new Set(pids).size === pids.length),
});

export interface BootstrapServiceReader {
  readService(service: string): Promise<string>;
  inspectProcess(pid: number): Promise<unknown>;
}

export interface NativeBootstrapServiceReader extends BootstrapServiceReader {
  inspectRunningProcess(pid: number): Promise<z.infer<typeof RunningProcessObservationSchema>>;
  verifyProcessExited(pid: number): Promise<void>;
  verifyServiceAbsent(service: string): Promise<void>;
  inspectStoppedProcess(pid: number): Promise<z.infer<typeof FrozenProcessObservationSchema>>;
}

export async function readBootstrapLauncher(
  file: CoordinatorBootstrapPlan["candidate"]["launcher"],
  writableMountRoots: readonly string[],
): Promise<unknown> {
  if (process.platform !== "darwin")
    throw new BootstrapRequestConflict("Coordinator launcher parsing requires native macOS Host");
  const bytes = await readBootstrapPreparedFile(file, writableMountRoots);
  // plutil receives only the verified bytes. Its diagnostic output may contain
  // configuration values, so neither errors nor stdout escape on parse failure.
  const output = await new Promise<string>((resolve, reject) => {
    const fail = () =>
      reject(new BootstrapRequestConflict("Prepared launcher is not a valid plist"));
    const child = execFile(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) fail();
        else resolve(stdout);
      },
    );
    child.stdin!.on("error", fail);
    child.stdin!.end(bytes);
  });
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(output));
  } catch {
    throw new BootstrapRequestConflict("Prepared launcher is not a plist dictionary");
  }
}

/** Plists are decoded by the fixed Host parser. Preserve environment, logs and
 * lifetime settings while changing only the approved executable/config paths. */
export function verifyBootstrapLaunchers(input: {
  plan: CoordinatorBootstrapPlan;
  configurationFile: string;
  current: unknown;
  previous: unknown;
  candidate: unknown;
}): void {
  const schema = z.record(z.string(), z.unknown());
  const current = schema.parse(input.current);
  const previous = schema.parse(input.previous);
  const candidate = schema.parse(input.candidate);
  const currentArguments = [
    input.plan.previous.node.path,
    input.plan.previous.entrypoint.path,
    input.configurationFile,
  ];
  const label = input.plan.service.split("/").slice(2).join("/");
  const matchingLauncher =
    current.Label === label &&
    isDeepStrictEqual(current.ProgramArguments, currentArguments) &&
    (current.Program === undefined || current.Program === input.plan.previous.node.path);
  if (!matchingLauncher || !isDeepStrictEqual(current, previous))
    throw new BootstrapRequestConflict(
      "Current coordinator launcher no longer matches preparation",
    );
  const expected: Record<string, unknown> = {
    ...current,
    ProgramArguments: [
      input.plan.candidate.node.path,
      input.plan.candidate.entrypoint.path,
      input.plan.candidate.configuration.path,
    ],
  };
  if (current.Program !== undefined) expected.Program = input.plan.candidate.node.path;
  if (!isDeepStrictEqual(candidate, expected))
    throw new BootstrapRequestConflict("Candidate launcher changes unapproved service settings");
}

/** Helper identity is supplied by protected Host setup, never by a review RPC.
 * Execute the verified buffer, not a pathname that can change after hashing. */
export async function createNativeBootstrapServiceReader(input: {
  helperPath: string;
  helperSha256: string;
  writableMountRoots: readonly string[];
}): Promise<NativeBootstrapServiceReader> {
  if (process.platform !== "darwin" || !process.getuid)
    throw new BootstrapRequestConflict("Coordinator inspection requires native macOS Host");
  const uid = process.getuid();
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.helperSha256);
  if ((await realpath(input.helperPath)) !== input.helperPath)
    throw new BootstrapRequestConflict("Coordinator inspector requires its canonical path");
  await assertBootstrapPathsProtected([input.helperPath], input.writableMountRoots);
  const fd = await open(
    input.helperPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let source: string;
  try {
    const before = await fd.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o022n) !== 0n ||
      before.size > 1024n * 1024n
    )
      throw new BootstrapRequestConflict("Coordinator inspector must be a protected owned file");
    const bytes = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    const changed =
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      before.size !== after.size ||
      before.mode !== after.mode;
    if (changed || createHash("sha256").update(bytes).digest("hex") !== input.helperSha256)
      throw new BootstrapRequestConflict("Coordinator inspector bytes changed");
    source = bytes.toString("utf8");
  } finally {
    await fd.close();
  }
  const options = { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000, maxBuffer: 1024 * 1024 };
  return {
    async readService(service) {
      const label = z
        .string()
        .regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+\.installation$/)
        .parse(service);
      if (!label.startsWith(`gui/${uid}/`))
        throw new BootstrapRequestConflict("Coordinator service belongs to another Host account");
      const result = await execute("/bin/launchctl", ["print", label], options);
      return result.stdout;
    },
    async verifyServiceAbsent(service) {
      const label = z
        .string()
        .regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+\.installation$/)
        .parse(service);
      if (!label.startsWith(`gui/${uid}/`))
        throw new BootstrapRequestConflict("Coordinator service belongs to another Host account");
      try {
        await execute("/bin/launchctl", ["print", label], options);
      } catch (error) {
        const result = z.object({ code: z.literal(113), stderr: z.string() }).safeParse(error);
        const serviceName = label.split("/").slice(2).join("/");
        const missing = `Bad request.\nCould not find service "${serviceName}" in domain for user gui: ${uid}`;
        if (result.success && result.data.stderr.trim() === missing) return;
        throw new BootstrapRequestConflict("Coordinator service absence could not be verified");
      }
      throw new BootstrapRequestConflict("Coordinator service is still loaded");
    },
    async inspectRunningProcess(pid) {
      z.number().int().positive().parse(pid);
      const result = await execute(
        "/usr/bin/python3",
        ["-I", "-B", "-c", source, String(pid), "--require-running"],
        options,
      );
      return RunningProcessObservationSchema.parse(JSON.parse(result.stdout));
    },
    async verifyProcessExited(pid) {
      z.number().int().positive().parse(pid);
      const result = await execute(
        "/usr/bin/python3",
        ["-I", "-B", "-c", source, String(pid), "--require-exited"],
        options,
      );
      const observation = ExitedProcessObservationSchema.parse(JSON.parse(result.stdout));
      if (observation.pid !== pid)
        throw new BootstrapRequestConflict("Process exit identity changed");
    },
    async inspectStoppedProcess(pid) {
      z.number().int().positive().parse(pid);
      const result = await execute(
        "/usr/bin/python3",
        ["-I", "-B", "-c", source, String(pid), "--require-stopped"],
        options,
      );
      return FrozenProcessObservationSchema.parse(JSON.parse(result.stdout));
    },
    async inspectProcess(pid) {
      z.number().int().positive().parse(pid);
      const result = await execute(
        "/usr/bin/python3",
        ["-I", "-B", "-c", source, String(pid)],
        options,
      );
      return ProcessObservationSchema.parse(JSON.parse(result.stdout));
    },
  };
}

export async function verifyLoadedBootstrapService(input: {
  plan: CoordinatorBootstrapPlan;
  hostUid: number;
  configurationFile: string;
  reader: BootstrapServiceReader;
}): Promise<void> {
  for (let observation = 0; observation < 2; observation++) {
    const launchctlOutput = await input.reader.readService(input.plan.service);
    const pid = loadedCoordinatorPid(input.plan.service, launchctlOutput);
    // Do not inspect an unexpected process merely because a service changed.
    if (pid !== input.plan.expectedProcess.pid)
      throw new BootstrapRequestConflict("Loaded coordinator PID changed during verification");
    const process = await input.reader.inspectProcess(pid);
    verifyBootstrapServiceIdentity({ ...input, launchctlOutput, process });
  }
  const finalService = await input.reader.readService(input.plan.service);
  if (loadedCoordinatorPid(input.plan.service, finalService) !== input.plan.expectedProcess.pid)
    throw new BootstrapRequestConflict("Loaded coordinator PID changed during verification");
}

/** Read only the top-level PID from launchctl's service record. Nested resource
 * records and incomplete or ambiguous output cannot identify the coordinator. */
export function loadedCoordinatorPid(service: string, output: string): number {
  if (!output.startsWith(`${service} = {\n`) || !output.trimEnd().endsWith("\n}"))
    throw new BootstrapRequestConflict("Loaded coordinator service identity does not match");
  const pids = [...output.matchAll(/^\tpid = ([1-9]\d*)$/gm)];
  if (pids.length !== 1)
    throw new BootstrapRequestConflict("Loaded coordinator PID is missing or ambiguous");
  const pid = Number(pids[0]?.[1]);
  if (!Number.isSafeInteger(pid))
    throw new BootstrapRequestConflict("Loaded coordinator PID is invalid");
  return pid;
}

/** The output and kernel observation come from trusted read-only Host collectors.
 * File integrity, protected paths and a second observation still gate dispatch. */
export function verifyBootstrapServiceIdentity(input: {
  plan: CoordinatorBootstrapPlan;
  launchctlOutput: string;
  process: unknown;
  hostUid: number;
  configurationFile: string;
}): void {
  const observation = ProcessObservationSchema.parse(input.process);
  const pid = loadedCoordinatorPid(input.plan.service, input.launchctlOutput);
  const expected = input.plan.expectedProcess;
  const matchesProcess =
    pid === expected.pid &&
    observation.pid === pid &&
    observation.bootId === expected.bootId &&
    observation.startIdentity === expected.startIdentity &&
    observation.argumentsSha256 === expected.argumentsSha256;
  if (!matchesProcess)
    throw new BootstrapRequestConflict("Loaded coordinator process changed since preparation");
  if (observation.uid !== input.hostUid || observation.parentPid !== 1)
    throw new BootstrapRequestConflict("Coordinator is not owned by the Host launch service");
  const argumentsDigest = createHash("sha256")
    .update(
      JSON.stringify([
        input.plan.previous.node.path,
        input.plan.previous.entrypoint.path,
        input.configurationFile,
      ]),
    )
    .digest("hex");
  const matchesLauncher =
    observation.executable === input.plan.previous.node.path &&
    observation.argumentsSha256 === argumentsDigest;
  if (!matchesLauncher)
    throw new BootstrapRequestConflict("Running coordinator does not match the prepared launcher");
}
