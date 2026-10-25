import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import type { FactoryVerifyConfiguration } from "@getpaseo/protocol/execution-installation";

const execute = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;

/** Runs a pinned executable. Tests replace it; production uses execFile without a shell. */
export type EngineCommand = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

export const defaultRun: EngineCommand = async (file, args, timeoutMs) => {
  const { stdout } = await execute(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 });
  return { stdout };
};

/** Where Factory's check runs: the pinned Docker binary, socket and Dev container. */
export interface FactoryVerifyTarget {
  docker: string;
  socket: string;
  container: string;
  verify: FactoryVerifyConfiguration;
}

/** Facts on Factory's JSON line. Unknown fields are ignored; newer ones are optional. */
const FactoryFactsSchema = z.looseObject({
  ok: z.boolean(),
  check: z.string().max(80),
  epoch: z.number().int().nonnegative().optional(),
  supervisorPid: z.number().int().positive().optional(),
  lockDevice: z.number().int().nonnegative().optional(),
  lockInode: z.number().int().nonnegative().optional(),
  ownerMode: z.string().max(40).optional(),
  ownerSequence: z.number().int().nonnegative().optional(),
  custodyCount: z.number().int().nonnegative().optional(),
  custodyDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type FactoryFacts = Pick<
  z.infer<typeof FactoryFactsSchema>,
  | "ok"
  | "check"
  | "epoch"
  | "supervisorPid"
  | "lockDevice"
  | "lockInode"
  | "ownerMode"
  | "ownerSequence"
  | "custodyCount"
  | "custodyDigest"
>;

/** Factory's script must be an owner-controlled physical file with the pinned digest. */
export function assertFactoryVerifyScript(verify: FactoryVerifyConfiguration): void {
  const file = lstatSync(verify.script);
  if (
    !file.isFile() ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o022) !== 0 ||
    realpathSync(verify.script) !== verify.script
  )
    throw new Error("Factory verification requires an owner-controlled physical script");
  if (createHash("sha256").update(readFileSync(verify.script)).digest("hex") !== verify.sha256)
    throw new Error("Factory verification script changed");
  accessSync(verify.script, constants.X_OK);
}

/** Read-only. A failed check, a crash or an unreadable receipt all return ok: false. */
export async function runFactoryVerify(
  target: FactoryVerifyTarget,
  run: EngineCommand = defaultRun,
  /** Host-side custody flags (v2): `--write-custody-list` or `--custody-superset-of`. */
  extraArgs: string[] = [],
): Promise<FactoryFacts> {
  const { verify } = target;
  assertFactoryVerifyScript(verify);
  let stdout: string;
  try {
    ({ stdout } = await run(
      verify.script,
      [
        "--docker",
        target.docker,
        "--socket",
        target.socket,
        "--container",
        target.container,
        "--lock-inode",
        String(verify.lockInode),
        "--owner-mode",
        verify.ownerMode,
        ...extraArgs,
      ],
      COMMAND_TIMEOUT_MS,
    ));
  } catch (error) {
    // A failing check exits 1 with its JSON line on stdout; read it when present.
    const output =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    if (!output.trim()) return { ok: false, check: "execution" };
    stdout = output;
  }
  try {
    const facts = FactoryFactsSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
    return {
      ok: facts.ok,
      check: facts.check,
      epoch: facts.epoch,
      supervisorPid: facts.supervisorPid,
      lockDevice: facts.lockDevice,
      lockInode: facts.lockInode,
      ownerMode: facts.ownerMode,
      ownerSequence: facts.ownerSequence,
      custodyCount: facts.custodyCount,
      custodyDigest: facts.custodyDigest,
    };
  } catch {
    return { ok: false, check: "receipt" };
  }
}
