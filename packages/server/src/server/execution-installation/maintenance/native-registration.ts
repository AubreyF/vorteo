import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  EnrollmentNativeIdentitySchema,
  enrollmentNativeIdentityDigest,
  type EnrollmentNativeIdentity,
} from "./native-identity.js";

const MAX_IDENTITY_BYTES = 64 * 1024;

function requirePrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (
    realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error("Maintenance identity directory requires protected canonical Host custody");
}

function identityDirectory(stateDirectory: string): string {
  requirePrivateDirectory(stateDirectory);
  return path.join(stateDirectory, "maintenance-identities");
}

function identityFile(directory: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid maintenance identity digest");
  return path.join(directory, `${digest}.json`);
}

/** Immutable expected identity, never evidence that the target is currently registered or healthy.
 * The manifest selects this digest under lifecycle admission; no nested lock is acquired here. */
export function readEnrollmentNativeIdentity(
  stateDirectory: string,
  identitySha256: string,
): EnrollmentNativeIdentity {
  const directory = identityDirectory(stateDirectory);
  requirePrivateDirectory(directory);
  const file = identityFile(directory, identitySha256);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o077n) !== 0n ||
      before.size > BigInt(MAX_IDENTITY_BYTES)
    )
      throw new Error("Maintenance identity requires a bounded private nonlinked file");
    const bytes = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    const selected = lstatSync(file, { bigint: true });
    for (const stat of [after, selected]) {
      if (
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.ctimeNs !== before.ctimeNs ||
        stat.mtimeNs !== before.mtimeNs ||
        stat.size !== before.size
      )
        throw new Error("Maintenance identity changed during reading");
    }
    const identity = EnrollmentNativeIdentitySchema.parse(JSON.parse(bytes));
    if (
      enrollmentNativeIdentityDigest(identity) !== identitySha256 ||
      identity.custodyOwnerUid !== process.getuid?.()
    )
      throw new Error("Maintenance identity differs from the enrolled target");
    return identity;
  } finally {
    closeSync(fd);
  }
}

/** Call only after independent native preparation. Exclusive immutable names prevent
 * overwriting an enrolled identity; uncertain writes require read-only reconciliation. */
export function retainEnrollmentNativeIdentity(
  stateDirectory: string,
  descriptor: EnrollmentNativeIdentity,
  publication: { link: typeof linkSync } = { link: linkSync },
): string {
  const identity = EnrollmentNativeIdentitySchema.parse(descriptor);
  const digest = enrollmentNativeIdentityDigest(identity);
  if (identity.custodyOwnerUid !== process.getuid?.())
    throw new Error("Maintenance identity differs from protected Host custody");
  const directory = identityDirectory(stateDirectory);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  requirePrivateDirectory(directory);
  const bytes = JSON.stringify(identity) + "\n";
  if (Buffer.byteLength(bytes) > MAX_IDENTITY_BYTES)
    throw new Error("Maintenance identity exceeds its size limit");
  const file = identityFile(directory, digest);
  const temporary = path.join(directory, `.${digest}.${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      publication.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    removeTemporary(temporary);
  }
  reconcilePublishedAliases(directory, file, digest);
  readEnrollmentNativeIdentity(stateDirectory, digest);
  synchronize(file, directory, stateDirectory);
  return digest;
}

function removeTemporary(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A crash after atomic publication can retain the complete file's temporary name.
 * Remove only our private same-inode aliases, never replace the selected identity. */
function reconcilePublishedAliases(directory: string, file: string, digest: string): void {
  const selected = lstatSync(file);
  if (!selected.isFile() || selected.uid !== process.getuid?.() || (selected.mode & 0o077) !== 0)
    throw new Error("Published maintenance identity requires private Host custody");
  if (selected.nlink === 1) return;
  const prefix = `.${digest}.`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !/^[a-f0-9-]{36}\.tmp$/.test(entry.slice(prefix.length)))
      continue;
    const temporary = path.join(directory, entry);
    const stat = lstatSync(temporary);
    if (
      stat.isFile() &&
      stat.dev === selected.dev &&
      stat.ino === selected.ino &&
      stat.uid === selected.uid
    )
      removeTemporary(temporary);
  }
}

function synchronize(...files: string[]): void {
  for (const file of files) {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
