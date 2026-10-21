import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";

export function readPrivateBootstrapConfiguration(file: string, uid: number): unknown {
  return JSON.parse(readPrivateBootstrapConfigurationBytes(file, uid).toString("utf8"));
}

/** Return the same protected bytes used by configuration projection checks. */
export function readPrivateBootstrapConfigurationBytes(file: string, uid: number): Buffer {
  if (realpathSync(file) !== file)
    throw new BootstrapRequestConflict("Bootstrap configuration requires a canonical Host path");
  const parent = lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Bootstrap configuration requires a private Host directory");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size > 1024n * 1024n
    )
      throw new BootstrapRequestConflict("Bootstrap configuration must be a private owned file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      after.ctimeNs !== current.ctimeNs ||
      after.mtimeNs !== current.mtimeNs
    )
      throw new BootstrapRequestConflict("Bootstrap configuration changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Retain protected names before reading configuration or script contents. */
export function retainPrivateBootstrapFiles(files: readonly string[], uid: number): () => void {
  const retained = new Map<string, string>();
  function identity(file: string): string {
    const value = lstatSync(file, { bigint: true });
    if (
      realpathSync(file) !== file ||
      value.isSymbolicLink() ||
      (value.uid !== 0n && value.uid !== BigInt(uid)) ||
      (value.mode & 0o022n) !== 0n ||
      (!value.isDirectory() && (!value.isFile() || value.nlink !== 1n || value.size > 1048576n))
    )
      throw new BootstrapRequestConflict("Bootstrap configuration ancestry is unsafe");
    return [
      value.dev,
      value.ino,
      value.uid,
      value.gid,
      value.mode,
      ...(value.isDirectory() ? [] : [value.size, value.mtimeNs, value.ctimeNs, value.nlink]),
    ].join(":");
  }
  for (const file of files) {
    for (let current = file; ; current = path.dirname(current)) {
      const observed = identity(current);
      if (retained.has(current) && retained.get(current) !== observed)
        throw new BootstrapRequestConflict("Bootstrap configuration ancestry changed");
      retained.set(current, observed);
      if (retained.size > 256)
        throw new BootstrapRequestConflict("Bootstrap configuration ancestry exceeds its bound");
      if (path.dirname(current) === current) break;
    }
  }
  return () => {
    for (const [file, observed] of retained)
      if (identity(file) !== observed)
        throw new BootstrapRequestConflict("Bootstrap configuration custody changed");
  };
}
