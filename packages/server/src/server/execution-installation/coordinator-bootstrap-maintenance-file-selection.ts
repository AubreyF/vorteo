import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MAX_BYTES = 1024 * 1024;

interface SelectedFile {
  path: string;
  previousSha256: string | null;
  bytes: Buffer;
}

/** Called inside the existing lifecycle transaction after verifying the retained
 * reservation, native absence and both reviewed slots. It performs no service
 * commands. The immutable attempt fences every interrupted write, including a
 * crash between launcher and selection publication. An existing attempt is
 * observation-only, even if neither target appears to have changed.
 *
 * Both files must come from the inspected native plan, never request paths.
 * The caller rechecks native custody synchronously before entry; this function
 * rechecks file and parent identity before each publication. */
export function selectMaintenanceFiles(input: {
  attemptFile: string;
  reservationSha256: string;
  launcher: SelectedFile;
  selection: SelectedFile;
  assertCurrent(): void;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.reservationSha256))
    throw new BootstrapRequestConflict("Maintenance reservation digest is invalid");
  const files = [input.launcher, input.selection].map((file) => ({
    path: file.path,
    previousSha256: file.previousSha256,
    bytes: Buffer.from(file.bytes),
  }));
  if (new Set([input.attemptFile, ...files.map((file) => file.path)]).size !== 3)
    throw new BootstrapRequestConflict("Maintenance selection paths must be distinct");
  const parents = files.map((file) => protectedParent(file.path));
  const attemptParent = protectedParent(input.attemptFile);
  for (const file of files) {
    if (file.bytes.length > MAX_BYTES)
      throw new BootstrapRequestConflict("Maintenance selection exceeds its size bound");
    requirePrevious(file);
  }
  if (typeof input.assertCurrent !== "function" || input.assertCurrent() !== undefined)
    throw new BootstrapRequestConflict("Maintenance selection requires synchronous custody proof");
  const receipt = {
    version: 1,
    reservationSha256: input.reservationSha256,
    files: files.map((file) => ({
      path: file.path,
      previousSha256: file.previousSha256,
      sha256: digest(file.bytes),
    })),
  };
  const currentParent = protectedParent(input.attemptFile);
  if (currentParent.dev !== attemptParent.dev || currentParent.ino !== attemptParent.ino)
    throw new BootstrapRequestConflict("Maintenance attempt parent changed");
  // A torn attempt still blocks replay. Never delete or repair it on this path.
  writeExclusive(input.attemptFile, Buffer.from(JSON.stringify(receipt)));
  syncDirectory(path.dirname(input.attemptFile));
  for (const [index, file] of files.entries()) publish(file, parents[index]);
  return receipt;
}

function protectedParent(file: string) {
  const directory = path.dirname(file);
  const stat = lstatSync(directory, { bigint: true });
  if (
    realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o022n) !== 0n
  )
    throw new BootstrapRequestConflict("Maintenance selection parent is not protected");
  return { directory, dev: stat.dev, ino: stat.ino };
}

function requirePrevious(file: SelectedFile) {
  let fd: number;
  try {
    fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && file.previousSha256 === null) return;
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o022n) !== 0n ||
      stat.size > BigInt(MAX_BYTES)
    )
      throw new BootstrapRequestConflict("Maintenance selection is not a protected regular file");
    const bytes = readFileSync(fd);
    const current = lstatSync(file.path, { bigint: true });
    const after = fstatSync(fd, { bigint: true });
    if (
      [current, after].some(
        (item) =>
          item.dev !== stat.dev ||
          item.ino !== stat.ino ||
          item.ctimeNs !== stat.ctimeNs ||
          item.mtimeNs !== stat.mtimeNs,
      ) ||
      file.previousSha256 !== digest(bytes)
    )
      throw new BootstrapRequestConflict("Maintenance selection changed before publication");
  } finally {
    closeSync(fd);
  }
}

function writeExclusive(file: string, bytes: Buffer) {
  const fd = openSync(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publish(file: SelectedFile, parent: ReturnType<typeof protectedParent>) {
  const temporary = path.join(parent.directory, `.maintenance-selection-${randomUUID()}`);
  writeExclusive(temporary, file.bytes);
  let renamed = false;
  try {
    requirePrevious(file);
    const current = protectedParent(file.path);
    if (current.dev !== parent.dev || current.ino !== parent.ino)
      throw new BootstrapRequestConflict("Maintenance selection parent changed");
    if (file.previousSha256 === null) {
      // First installation must not overwrite a concurrently created selection.
      linkSync(temporary, file.path);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, file.path);
    }
    renamed = true;
    syncDirectory(parent.directory);
    requirePrevious({ ...file, previousSha256: digest(file.bytes) });
  } finally {
    if (!renamed) unlinkSync(temporary);
  }
}
