import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { assertFrozenCoordinatorIdle, BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { assertBootstrapPathsProtected } from "./coordinator-bootstrap-artifact.js";
import { OwnerSessionsSchema } from "./owner-sessions.js";

const DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const TransferSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  generation: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  restartJournal: DigestSchema,
  ownerSessions: DigestSchema,
});

interface StateContext {
  request: CoordinatorBootstrapRequest;
  writableMountRoots: readonly string[];
}

async function readStateFile(file: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !process.getuid ||
      before.uid !== BigInt(process.getuid()) ||
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size > 16n * 1024n * 1024n
    )
      throw new BootstrapRequestConflict("Coordinator state must be a bounded private owned file");
    const bytes = await handle.readFile();
    await handle.sync();
    for (const after of [
      await handle.stat({ bigint: true }),
      await lstat(file, { bigint: true }),
    ]) {
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs ||
        before.size !== after.size
      )
        throw new BootstrapRequestConflict("Coordinator state changed during preservation");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function digest(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

async function readState(context: StateContext) {
  const state = context.request.plan.state;
  if (
    (await realpath(state.directory)) !== state.directory ||
    state.restartJournal !== path.join(state.directory, "restart-jobs.json") ||
    state.ownerSessions !== path.join(state.directory, "owner-sessions.json")
  )
    throw new BootstrapRequestConflict("Coordinator state paths do not match the installation");
  await assertBootstrapPathsProtected([state.directory], context.writableMountRoots);
  const directory = await lstat(state.directory);
  if (
    !process.getuid ||
    directory.uid !== process.getuid() ||
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0
  )
    throw new BootstrapRequestConflict("Coordinator state directory must be private and owned");
  const journal = await readStateFile(state.restartJournal);
  const sessions = await readStateFile(state.ownerSessions);
  const after = await lstat(state.directory);
  if (
    directory.dev !== after.dev ||
    directory.ino !== after.ino ||
    directory.mode !== after.mode ||
    directory.uid !== after.uid ||
    (await realpath(state.directory)) !== state.directory
  )
    throw new BootstrapRequestConflict("Coordinator state directory changed during preservation");
  const restartJournal: unknown = journal === null ? [] : JSON.parse(journal.toString("utf8"));
  OwnerSessionsSchema.parse(sessions === null ? [] : JSON.parse(sessions.toString("utf8")));
  return { restartJournal, journalDigest: digest(journal), sessionDigest: digest(sessions) };
}

/** Contains hashes only. State is never copied back or rolled back. The native
 * executor must keep the old writer frozen and the replacement fenced. */
export async function preserveBootstrapState(
  context: StateContext & { childPids: unknown },
): Promise<void> {
  const execution = context.request.execution;
  const earlyRecovery =
    execution?.stage === "rollback_pending" &&
    context.request.plan.automaticRecovery === "restore-compatible";
  if (!execution || (execution.stage !== "frozen" && !earlyRecovery))
    throw new BootstrapRequestConflict("State preservation requires a frozen handoff");
  const state = await readState(context);
  assertFrozenCoordinatorIdle(state.restartJournal, context.childPids);
  const receipt = TransferSchema.parse({
    version: 1,
    requestId: context.request.id,
    generation: execution.generation,
    planSha256: context.request.planSha256,
    restartJournal: state.journalDigest,
    ownerSessions: state.sessionDigest,
  });
  const file = path.join(
    context.request.plan.state.directory,
    `coordinator-transfer-${execution.generation}.json`,
  );
  const existing = await readStateFile(file);
  if (existing !== null) {
    if (!earlyRecovery)
      throw new BootstrapRequestConflict("Coordinator preservation receipt already exists");
    // A completed receipt can survive an uncertain directory sync. Never
    // overwrite a different or partial receipt to make recovery appear settled.
    await verifyBootstrapState(context);
  } else {
    // Execution ownership excludes competing preservation. Atomic rename avoids
    // exposing a truncated receipt if the executor dies during its creation.
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}`);
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, JSON.stringify(receipt));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, file);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
  }
  const directory = await open(
    context.request.plan.state.directory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await verifyBootstrapState(context);
}

export async function inspectBootstrapState(context: StateContext): Promise<unknown> {
  return (await readState(context)).restartJournal;
}

export async function verifyBootstrapState(context: StateContext): Promise<void> {
  const execution = context.request.execution;
  if (!execution)
    throw new BootstrapRequestConflict("State verification requires a handoff generation");
  const state = await readState(context);
  const file = path.join(
    context.request.plan.state.directory,
    `coordinator-transfer-${execution.generation}.json`,
  );
  const bytes = await readStateFile(file);
  if (bytes === null)
    throw new BootstrapRequestConflict("Coordinator state preservation receipt is missing");
  const receipt = TransferSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    receipt.requestId !== context.request.id ||
    receipt.generation !== execution.generation ||
    receipt.planSha256 !== context.request.planSha256 ||
    receipt.restartJournal !== state.journalDigest ||
    receipt.ownerSessions !== state.sessionDigest
  )
    throw new BootstrapRequestConflict("Coordinator state no longer matches the preserved handoff");
}
