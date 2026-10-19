import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { Worker, parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

// Release trees hold over a hundred thousand files. Traversal, hashing and the
// final metadata sweep run on worker threads so the Host event loop stays free.
// This module must not import relative modules: tests load its TypeScript source
// directly as a worker. Digest lines and their order match the sequential
// implementation exactly, because the coordinator verifies the same digest.

const SCAN_ROLE = "vorteo-artifact-scan";
const DIGEST_ROLE = "vorteo-artifact-digest";
const VERIFY_ROLE = "vorteo-artifact-verify";
// Synchronous reads on worker threads bypass libuv's shared four-thread pool, so
// a scan cannot starve the Host's own asynchronous filesystem work.
const MAX_READERS = 8;
const FILES_PER_READER = 512;
const BATCH_FILES = 64;
const BATCH_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export class ArtifactScanConflict extends Error {}

// Workers inherit the parent's execArgv. Options that describe a main script's
// string input either make Node refuse to start a worker (--input-type, as in
// the bounded `--input-type=module --eval` verification children) or mean
// nothing to it (--eval, --print). Each takes a value, inline or as the next
// argument. --experimental-default-type is gone from current Node; older
// runtimes applied it to module type detection, so it is removed as well.
const MAIN_INPUT_OPTIONS = new Set([
  "--input-type",
  "--eval",
  "-e",
  "--print",
  "-p",
  "--experimental-default-type",
]);

export function workerExecArgv(parent: readonly string[] = process.execArgv): string[] {
  const kept: string[] = [];
  for (let index = 0; index < parent.length; index++) {
    const option = parent[index];
    const separator = option.indexOf("=");
    const name = separator === -1 ? option : option.slice(0, separator);
    if (!MAIN_INPUT_OPTIONS.has(name)) kept.push(option);
    else if (separator === -1) index++;
  }
  return kept;
}

export function identity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

const ScanRequestSchema = z.strictObject({
  role: z.literal(SCAN_ROLE),
  directory: z.string(),
  maxFiles: z.number().nullable(),
  maxBytes: z.number().nullable(),
  deadline: z.number().nullable(),
});
const DigestRequestSchema = z.strictObject({
  role: z.literal(DIGEST_ROLE),
  deadline: z.number().nullable(),
});
const VerifyRequestSchema = z.strictObject({
  role: z.literal(VERIFY_ROLE),
  directory: z.string(),
  paths: z.string(),
  identities: z.string(),
  deadline: z.number().nullable(),
});
const WorkerRequestSchema = z.discriminatedUnion("role", [
  ScanRequestSchema,
  DigestRequestSchema,
  VerifyRequestSchema,
]);
const DigestBatchSchema = z.array(z.tuple([z.string(), z.string()]));

const ScanFailureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conflict"), message: z.string() }),
  z.strictObject({
    kind: z.literal("system"),
    message: z.string(),
    code: z.string().nullable(),
    errno: z.number().nullable(),
    syscall: z.string().nullable(),
    path: z.string().nullable(),
  }),
]);
type ScanFailure = z.infer<typeof ScanFailureSchema>;
const ScanReplySchema = z.discriminatedUnion("type", [
  // NUL cannot occur in a path or identity, so one string crosses the thread
  // boundary instead of hundreds of thousands of cloned elements.
  z.strictObject({
    type: z.literal("result"),
    sha256: z.string(),
    paths: z.string(),
    identities: z.string(),
  }),
  z.strictObject({ type: z.literal("error"), failure: ScanFailureSchema }),
]);
const VerifyReplySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("current") }),
  z.strictObject({ type: z.literal("error"), failure: ScanFailureSchema }),
]);
const DigestReplySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("digests"), digests: z.array(z.string()) }),
  z.strictObject({ type: z.literal("error"), failure: ScanFailureSchema }),
]);

export interface ArtifactBudget {
  maxFiles: number;
  maxBytes: number;
  deadline: number;
  signal?: AbortSignal;
}

/** Every observed path with its metadata identity, in traversal order, kept
 * NUL-joined: one compact form serves assertions and crosses to workers cheaply. */
export interface ArtifactScan {
  sha256: string;
  observed: ObservedMetadata;
}

export interface ObservedMetadata {
  paths: string;
  identities: string;
}

function conflict(message: string): ArtifactScanConflict {
  return new ArtifactScanConflict(message);
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function describe(error: unknown): ScanFailure {
  if (error instanceof ArtifactScanConflict) return { kind: "conflict", message: error.message };
  const field = (name: string) =>
    error instanceof Error && name in error ? Reflect.get(error, name) : null;
  const text = (name: string) => {
    const value = field(name);
    return typeof value === "string" ? value : null;
  };
  const errno = field("errno");
  return {
    kind: "system",
    message: error instanceof Error ? error.message : String(error),
    code: text("code"),
    errno: typeof errno === "number" ? errno : null,
    syscall: text("syscall"),
    path: text("path"),
  };
}

/** Callers branch on filesystem codes such as ENOENT, so they cross threads intact. */
function revive(failure: ScanFailure): Error {
  if (failure.kind === "conflict") return conflict(failure.message);
  const error = new Error(failure.message);
  for (const name of ["code", "errno", "syscall", "path"] as const)
    if (failure[name] !== null) Reflect.set(error, name, failure[name]);
  return error;
}

function checkDeadline(deadline: number | null): void {
  if (deadline !== null && Date.now() >= deadline)
    throw conflict("Artifact verification deadline exceeded");
}

/** Runs the complete traversal off the calling thread. Cancellation and the
 * deadline terminate the workers rather than waiting for a read to return. */
export function scanArtifactTree(directory: string, input: ArtifactBudget): Promise<ArtifactScan> {
  const request: z.infer<typeof ScanRequestSchema> = {
    role: SCAN_ROLE,
    directory,
    maxFiles: finiteOrNull(input.maxFiles),
    maxBytes: finiteOrNull(input.maxBytes),
    deadline: finiteOrNull(input.deadline),
  };
  return runArtifactWorker(request, input, (message) => {
    const reply = ScanReplySchema.parse(message);
    if (reply.type === "error") throw revive(reply.failure);
    return { sha256: reply.sha256, observed: { paths: reply.paths, identities: reply.identities } };
  });
}

/** The same checks as a retained proof's synchronous assertion, performed off
 * the calling thread for a proof reused later in its operation. */
export async function verifyArtifactTree(
  directory: string,
  observed: ObservedMetadata,
  input: ArtifactBudget,
): Promise<void> {
  const request: z.infer<typeof VerifyRequestSchema> = {
    role: VERIFY_ROLE,
    directory,
    ...observed,
    deadline: finiteOrNull(input.deadline),
  };
  await runArtifactWorker(request, input, (message) => {
    const reply = VerifyReplySchema.parse(message);
    if (reply.type === "error") throw revive(reply.failure);
  });
}

/** Walks both NUL-joined lists in step without materializing arrays. */
export function* observedEntries(observed: ObservedMetadata): Generator<[string, string]> {
  let pathStart = 0;
  let identityStart = 0;
  for (;;) {
    const pathEnd = observed.paths.indexOf("\0", pathStart);
    const identityEnd = observed.identities.indexOf("\0", identityStart);
    const last = pathEnd === -1;
    if (last !== (identityEnd === -1)) throw new Error("Malformed artifact metadata");
    yield [
      observed.paths.slice(pathStart, last ? undefined : pathEnd),
      observed.identities.slice(identityStart, last ? undefined : identityEnd),
    ];
    if (last) return;
    pathStart = pathEnd + 1;
    identityStart = identityEnd + 1;
  }
}

function runArtifactWorker<T>(
  request: z.infer<typeof WorkerRequestSchema>,
  input: ArtifactBudget,
  accept: (message: unknown) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: request,
      execArgv: workerExecArgv(),
    });
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      complete();
    };
    const fail = (error: unknown) => settle(() => reject(error));
    const cancel = () => fail(conflict("Artifact verification cancelled"));
    const remaining = input.deadline - Date.now();
    const timer = Number.isFinite(remaining)
      ? setTimeout(
          () => fail(conflict("Artifact verification deadline exceeded")),
          Math.max(0, remaining),
        )
      : undefined;
    input.signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message: unknown) => {
      try {
        const value = accept(message);
        settle(() => resolve(value));
      } catch (error) {
        fail(error);
      }
    });
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("Artifact worker exited without a result")));
  });
}

function verifyObserved(request: z.infer<typeof VerifyRequestSchema>) {
  if (realpathSync(request.directory) !== request.directory)
    throw conflict("Retained artifact requires its canonical directory");
  for (const [file, expected] of observedEntries(request)) {
    checkDeadline(request.deadline);
    if (identity(lstatSync(file, { bigint: true })) !== expected)
      throw conflict("Prepared artifact changed during verification");
  }
  return { type: "current" as const };
}

interface PendingFile {
  relative: string;
  file: string;
  mode: string;
  identity: string;
  size: number;
}

function requireOwned(stat: BigIntStats): void {
  if (!process.getuid || stat.uid !== BigInt(process.getuid()))
    throw conflict("Prepared artifact must be owned by the Host account");
  // Symlink modes are not meaningful on macOS. Their targets are checked separately.
  if (!stat.isSymbolicLink() && (stat.mode & 0o022n) !== 0n)
    throw conflict("Prepared artifact is writable by another account");
}

async function scan(request: z.infer<typeof ScanRequestSchema>) {
  const { directory, deadline } = request;
  const maxFiles = request.maxFiles ?? Infinity;
  const maxBytes = request.maxBytes ?? Infinity;
  let files = 0;
  let bytes = 0;
  const checkBudget = () => {
    checkDeadline(deadline);
    if (files > maxFiles || bytes > maxBytes)
      throw conflict("Artifact verification limit exceeded");
  };
  checkBudget();
  // Node's asynchronous realpath is the native call; keep that behaviour.
  const root = realpathSync.native(directory);
  if (root !== directory) throw conflict("Prepared artifact requires a canonical directory");
  const records: Array<string | PendingFile> = [];
  const pending: PendingFile[] = [];
  const paths: string[] = [];
  const identities: string[] = [];
  const hardLinks = new Map<string, { count: bigint; paths: string[] }>();

  function visit(relative: string): void {
    files++;
    checkBudget();
    const file = path.join(root, relative);
    const before = lstatSync(file, { bigint: true });
    requireOwned(before);
    const observed = identity(before);
    paths.push(file);
    identities.push(observed);
    if (before.isDirectory()) {
      records.push(JSON.stringify(["directory", relative, String(before.mode)]) + "\n");
      for (const entry of readdirSync(file).sort()) visit(path.join(relative, entry));
    } else if (before.isFile()) {
      bytes += Number(before.size);
      checkBudget();
      if (before.nlink > 1n) {
        const key = `${before.dev}:${before.ino}`;
        const group = hardLinks.get(key) ?? { count: before.nlink, paths: [] };
        if (group.count !== before.nlink) throw conflict("Prepared hard-linked artifact changed");
        group.paths.push(relative);
        hardLinks.set(key, group);
      }
      const item = {
        relative,
        file,
        mode: String(before.mode),
        identity: observed,
        size: Number(before.size),
      };
      pending.push(item);
      records.push(item);
    } else if (before.isSymbolicLink()) {
      const target = readlinkSync(file);
      const resolved = realpathSync.native(file);
      if (resolved !== root && !resolved.startsWith(root + path.sep))
        throw conflict("Prepared artifact links outside its release");
      records.push(JSON.stringify(["link", relative, target]) + "\n");
    } else {
      throw conflict("Prepared artifact contains a non-runtime file type");
    }
  }

  if (!lstatSync(root).isDirectory()) throw conflict("Prepared artifact must be a directory");
  visit("");
  const digests = await digestFiles(pending, deadline);
  const hash = createHash("sha256");
  hash.update("vorteo-coordinator-artifact-v1\n");
  for (const record of records) {
    if (typeof record === "string") hash.update(record);
    else {
      const digest = digests.get(record);
      if (digest === undefined) throw new Error("Artifact digest is missing");
      hash.update(JSON.stringify(["file", record.relative, record.mode, digest]) + "\n");
    }
  }
  // npm links some executable packages within the release. Count every physical
  // name, without following symlinks, so an alias outside this tree is refused.
  for (const group of hardLinks.values()) {
    if (BigInt(group.paths.length) !== group.count)
      throw conflict("Prepared hard-linked file escapes its release");
    hash.update(JSON.stringify(["hard-links", group.paths.sort()]) + "\n");
  }
  // A dependency visited earlier may change while another subtree is read.
  for (const [index, file] of paths.entries()) {
    checkBudget();
    if (identity(lstatSync(file, { bigint: true })) !== identities[index])
      throw conflict("Prepared artifact changed during verification");
  }
  checkBudget();
  return {
    type: "result" as const,
    sha256: hash.digest("hex"),
    paths: paths.join("\0"),
    identities: identities.join("\0"),
  };
}

function nextBatch(pending: readonly PendingFile[], start: number): number {
  let end = start;
  let size = 0;
  while (end < pending.length && end - start < BATCH_FILES && (end === start || size < BATCH_BYTES))
    size += pending[end++].size;
  return end;
}

/** Bounded parallel reads: each reader holds one open file and one buffer. */
function digestFiles(
  pending: readonly PendingFile[],
  deadline: number | null,
): Promise<Map<PendingFile, string>> {
  const digests = new Map<PendingFile, string>();
  if (pending.length === 0) return Promise.resolve(digests);
  const readers = Math.min(MAX_READERS, Math.ceil(pending.length / FILES_PER_READER));
  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    let next = 0;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      for (const worker of workers) void worker.terminate();
      if (error) reject(error);
      else resolve(digests);
    };
    for (let index = 0; index < readers; index++) {
      // Inside the scan worker, execArgv is already the filtered set; filtering
      // again keeps readers safe however the scan worker itself was started.
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { role: DIGEST_ROLE, deadline } satisfies z.infer<typeof DigestRequestSchema>,
        execArgv: workerExecArgv(),
      });
      workers.push(worker);
      let batch: readonly PendingFile[] = [];
      const dispatch = () => {
        const end = nextBatch(pending, next);
        batch = pending.slice(next, end);
        next = end;
        if (batch.length === 0) return;
        // A worker_threads port has no origin; the browser rule does not apply.
        // eslint-disable-next-line unicorn/require-post-message-target-origin
        worker.postMessage(batch.map((item) => [item.file, item.identity]));
      };
      worker.on("message", (message: unknown) => {
        const reply = DigestReplySchema.parse(message);
        if (reply.type === "error") return finish(revive(reply.failure));
        if (reply.digests.length !== batch.length) return finish(new Error("Malformed digests"));
        for (const [position, item] of batch.entries()) digests.set(item, reply.digests[position]);
        if (digests.size === pending.length) return finish(null);
        dispatch();
      });
      worker.on("error", (error) => finish(error));
      worker.on("exit", () => {
        if (batch.length > 0) finish(new Error("Artifact digest reader exited"));
      });
      dispatch();
    }
  });
}

function digestFile(file: string, expected: string, buffer: Buffer, deadline: number | null) {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (identity(fstatSync(descriptor, { bigint: true })) !== expected)
      throw conflict("Prepared artifact changed during verification");
    const hash = createHash("sha256");
    for (;;) {
      checkDeadline(deadline);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (identity(fstatSync(descriptor, { bigint: true })) !== expected)
      throw conflict("Prepared artifact changed during verification");
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function serveDigests(port: NonNullable<typeof parentPort>, deadline: number | null): void {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  port.on("message", (message: unknown) => {
    try {
      const digests = DigestBatchSchema.parse(message).map(([file, expected]) =>
        digestFile(file, expected, buffer, deadline),
      );
      port.postMessage({ type: "digests", digests });
    } catch (error) {
      port.postMessage({ type: "error", failure: describe(error) });
    }
  });
}

// Host daemon code may itself run on a worker thread; only the exact roles above
// start a scan, never an unrelated thread's workerData.
const request = parentPort ? WorkerRequestSchema.safeParse(workerData) : undefined;
if (parentPort && request?.success) {
  const port = parentPort;
  const reply = (work: Promise<object>) =>
    work.then(
      (result) => port.postMessage(result),
      (error: unknown) => port.postMessage({ type: "error", failure: describe(error) }),
    );
  const data = request.data;
  if (data.role === DIGEST_ROLE) serveDigests(port, data.deadline);
  else if (data.role === VERIFY_ROLE) void reply(Promise.resolve(data).then(verifyObserved));
  else void reply(scan(data));
}
