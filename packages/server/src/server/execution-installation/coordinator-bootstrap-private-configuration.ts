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
    const bytes = readFileSync(fd, "utf8");
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
    return JSON.parse(bytes);
  } finally {
    closeSync(fd);
  }
}
