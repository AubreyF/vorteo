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
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  symlinkSync,
  type BigIntStats,
} from "node:fs";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { assertReleaseSelectionAllowed } from "./release-selection-guard.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MAX_BYTES = 1024 * 1024;

interface SelectedFile {
  path: string;
  previousSha256: string | null;
  bytes: Buffer;
}

/** The Host selector is a symlink, unlike maintenance-service JSON selections.
 * Called under lifecycle exclusion with independently verified target absence,
 * artifacts and executor custody. The caller supplies reviewed paths only.
 * An uncertain publication retains the addressed attempt and is never replayed. */
export function selectMaintenanceReleaseLink(input: {
  attemptFile: string;
  reservationSha256: string;
  link: string;
  previous: string;
  candidate: string;
  assertCurrent(): void;
}) {
  const { attemptFile, reservationSha256, link, previous, candidate, assertCurrent } = input;
  // Defense for plans approved before the session host job was installed.
  assertReleaseSelectionAllowed({ link, candidate });
  if (!/^[a-f0-9]{64}$/.test(reservationSha256))
    throw new BootstrapRequestConflict("Release selection reservation digest is invalid");
  if (new Set([attemptFile, link, previous, candidate]).size !== 4)
    throw new BootstrapRequestConflict("Release selection paths must be distinct");
  const paths = [attemptFile, link, previous, candidate];
  if (paths.some((file) => !path.isAbsolute(file) || path.normalize(file) !== file))
    throw new BootstrapRequestConflict("Release selection requires canonical absolute paths");
  if (
    [previous, candidate].some((directory) =>
      [attemptFile, link].some((file) => file.startsWith(directory + path.sep)),
    )
  )
    throw new BootstrapRequestConflict(
      "Release selection must preserve prepared runtime directories",
    );
  const parent = protectedParent(link);
  const attemptParent = protectedParent(attemptFile);
  const nextDirectory = protectedParent(path.join(candidate, ".maintenance-release-probe"));
  protectedParent(path.join(previous, ".maintenance-release-probe"));
  const expected = releaseLinkIdentity(link, previous);
  const assertSelection = () => {
    if (typeof assertCurrent !== "function" || assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Release selection requires synchronous custody proof");
    requireSameParent(link, parent);
    requireSameParent(attemptFile, attemptParent);
    requireSameParent(path.join(candidate, ".maintenance-release-probe"), nextDirectory);
    if (releaseLinkIdentity(link, previous) !== expected)
      throw new BootstrapRequestConflict("Release selector changed before publication");
  };
  assertSelection();
  const receipt = {
    version: 1,
    operation: "release-link-selection",
    reservationSha256,
    link,
    previous,
    candidate,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  writeExclusive(attemptFile, receiptBytes);
  const assertAttempt = retainMaintenancePublishedFile(attemptFile, receiptBytes);
  syncDirectory(attemptParent.directory);
  const temporary = path.join(parent.directory, `.maintenance-release-${randomUUID()}`);
  symlinkSync(candidate, temporary);
  const stagedIdentity = releaseLinkIdentity(temporary, candidate);
  let renamed = false;
  try {
    assertSelection();
    assertAttempt();
    if (releaseLinkIdentity(temporary, candidate) !== stagedIdentity)
      throw new BootstrapRequestConflict("Staged release selector changed before publication");
    renameSync(temporary, link);
    renamed = true;
    syncDirectory(parent.directory);
    requireSameParent(link, parent);
    requireSameParent(path.join(candidate, ".maintenance-release-probe"), nextDirectory);
    releaseLinkIdentity(link, candidate);
    assertAttempt();
  } finally {
    if (!renamed) removeRetainedReleaseLink(temporary, candidate, stagedIdentity);
  }
  return receipt;
}

/** Retain both exact bytes and lifetime across later native/file phases. */
export function retainMaintenancePublishedFile(file: string, bytes: Buffer) {
  bytes = Buffer.from(bytes);
  const expected = linkStatIdentity(lstatSync(file, { bigint: true }));
  const selected = { path: file, previousSha256: digest(bytes), bytes };
  const assertCurrent = () => {
    if (linkStatIdentity(lstatSync(file, { bigint: true })) !== expected)
      throw new BootstrapRequestConflict("Release selection attempt changed");
    requirePrevious(selected);
    if (linkStatIdentity(lstatSync(file, { bigint: true })) !== expected)
      throw new BootstrapRequestConflict("Release selection attempt changed during inspection");
  };
  assertCurrent();
  return assertCurrent;
}

/** Retain the exact published selector across later custody callbacks. */
export function retainMaintenancePublishedLink(link: string, target: string) {
  const parent = protectedParent(link);
  const expected = releaseLinkIdentity(link, target);
  return () => {
    requireSameParent(link, parent);
    if (releaseLinkIdentity(link, target) !== expected)
      throw new BootstrapRequestConflict("Published release selector changed");
  };
}

function removeRetainedReleaseLink(file: string, target: string, expected: string) {
  let stat: BigIntStats;
  try {
    stat = lstatSync(file, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSymbolicLink() || linkStatIdentity(stat) !== expected) return;
  if (readlinkSync(file) !== target) return;
  if (linkStatIdentity(lstatSync(file, { bigint: true })) === expected) unlinkSync(file);
}

function requireSameParent(file: string, expected: ReturnType<typeof protectedParent>) {
  const current = protectedParent(file);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    throw new BootstrapRequestConflict("Release selection parent changed");
}

function linkStatIdentity(stat: BigIntStats) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.nlink,
    stat.size,
    stat.ctimeNs,
    stat.mtimeNs,
  ].join(":");
}

function releaseLinkIdentity(file: string, expected: string): string {
  const before = lstatSync(file, { bigint: true });
  if (!before.isSymbolicLink() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n)
    throw new BootstrapRequestConflict("Release selector must be an owned symbolic link");
  const target = readlinkSync(file);
  if (realpathSync(file) !== expected || realpathSync(expected) !== expected)
    throw new BootstrapRequestConflict("Release selector changed its reviewed target");
  const identity = linkStatIdentity(before);
  if (
    linkStatIdentity(lstatSync(file, { bigint: true })) !== identity ||
    readlinkSync(file) !== target
  )
    throw new BootstrapRequestConflict("Release selector changed during inspection");
  return identity;
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
