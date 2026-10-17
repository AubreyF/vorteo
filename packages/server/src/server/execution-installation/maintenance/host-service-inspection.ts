import { execFile, execFileSync } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import type { NativeBootstrapServiceReader } from "../coordinator-bootstrap-service.js";
import { EnrollmentNativeIdentitySchema } from "./native-identity.js";

const execute = promisify(execFile);
const DEADLINE_MS = 2000;
type ProcessReader = Pick<NativeBootstrapServiceReader, "inspectProcess" | "verifyProcessExited">;
interface CommandOptions {
  env: { PATH: string };
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
}
export interface HostServiceInspectionCommands {
  run(executable: string, args: string[], options: CommandOptions): Promise<unknown>;
  runSync(executable: string, args: string[], options: CommandOptions): unknown;
  now(): number;
}
const nativeCommands: HostServiceInspectionCommands = {
  async run(executable, args, options) {
    requireMatch(process.platform === "darwin", "Host service inspection requires macOS");
    return execute(executable, args, options);
  },
  runSync(executable, args, options) {
    requireMatch(process.platform === "darwin", "Host service inspection requires macOS");
    return execFileSync(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  },
  now: () => performance.now(),
};
function printOptions(): CommandOptions {
  return {
    env: { PATH: "/usr/bin:/bin" },
    timeout: DEADLINE_MS,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  };
}
function requireMatch(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(message);
}
function requireAbsent(error: unknown, resultField: "code" | "status", missing: string) {
  const failure = z.object({
    signal: z.null().optional(),
    killed: z.literal(false).optional(),
    stdout: z.literal("").optional(),
    stderr: z.string(),
  });
  const schema =
    resultField === "code"
      ? failure.extend({ code: z.literal(113) })
      : failure.extend({ status: z.literal(113) });
  const result = schema.safeParse(error);
  requireMatch(
    result.success && result.data.stderr.trim() === missing,
    "Enrolled Host service absence is unproven",
  );
}

/** Binds launchd absence to one enrolled Host identity. The maintenance reader's
 * narrower label checks stay unchanged. This supplies neither runtime absence
 * nor provider settlement, and exposes no service command or effect authority. */
export function createEnrolledHostServiceInspection(
  input: { identity: unknown; reader: ProcessReader },
  commands: HostServiceInspectionCommands = nativeCommands,
) {
  const identity = EnrollmentNativeIdentitySchema.parse(input.identity);
  const uid = process.getuid?.();
  requireMatch(
    identity.environment === "host" &&
      identity.target === "host" &&
      uid !== undefined &&
      identity.custodyOwnerUid === uid &&
      identity.serviceDomain === `gui/${uid}`,
    "Host service inspection differs from enrolled account custody",
  );
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const missing = `Bad request.\nCould not find service "${identity.serviceLabel}" in domain for user gui: ${uid}`;
  const reader = input.reader;
  const inspectProcess = reader.inspectProcess;
  const verifyProcessExited = reader.verifyProcessExited;
  const run = commands.run;
  const runSync = commands.runSync;
  const now = commands.now;
  requireMatch(
    [inspectProcess, verifyProcessExited, run, runSync, now].every(
      (value) => typeof value === "function",
    ),
    "Host service inspection requires retained native readers",
  );
  const assertCurrent = () => {
    requireMatch(
      process.getuid?.() === uid &&
        isDeepStrictEqual(EnrollmentNativeIdentitySchema.parse(input.identity), identity) &&
        input.reader === reader &&
        reader.inspectProcess === inspectProcess &&
        reader.verifyProcessExited === verifyProcessExited &&
        commands.run === run &&
        commands.runSync === runSync &&
        commands.now === now,
      "Host service inspection custody changed",
    );
  };
  function assertBudget(started: number) {
    const elapsed = now.call(commands) - started;
    requireMatch(
      Number.isFinite(elapsed) && elapsed >= 0 && elapsed < DEADLINE_MS,
      "Host service inspection exceeded its collection deadline",
    );
  }
  return {
    service,
    assertCurrent,
    /** Repeat inside the caller's retained assertion alongside runtime inventory,
     * process-exit, protected-file and current admission custody. */
    assertServiceAbsent() {
      assertCurrent();
      const started = now.call(commands);
      let absent = false;
      try {
        runSync.call(commands, "/bin/launchctl", ["print", service], printOptions());
      } catch (error) {
        requireAbsent(error, "status", missing);
        absent = true;
      }
      assertCurrent();
      assertBudget(started);
      requireMatch(absent, "Enrolled Host service is still registered");
    },
    // Only the process methods needed by initial Host transition are forwarded.
    // In particular, the original reader's readService does not gain Host scope.
    reader: {
      async inspectProcess(pid: number) {
        assertCurrent();
        const result = await inspectProcess.call(reader, pid);
        assertCurrent();
        return result;
      },
      async verifyProcessExited(pid: number) {
        assertCurrent();
        await verifyProcessExited.call(reader, pid);
        assertCurrent();
      },
      async verifyServiceAbsent(target: string) {
        assertCurrent();
        requireMatch(target === service, "Host absence request differs from enrolled service");
        const started = now.call(commands);
        let absent = false;
        try {
          await run.call(commands, "/bin/launchctl", ["print", service], printOptions());
        } catch (error) {
          requireAbsent(error, "code", missing);
          absent = true;
        }
        assertCurrent();
        assertBudget(started);
        requireMatch(absent, "Enrolled Host service is still registered");
      },
    },
  };
}
