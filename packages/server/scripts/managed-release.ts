import {
  readFileSync,
  realpathSync,
  statSync,
  lstatSync,
  readlinkSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

const ReceiptSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) });

/** Resolve on every spawn, including owner-approved restart, rather than pinning the boot release. */
export function resolveManagedWorker(
  env: NodeJS.ProcessEnv,
  readReceipt = (file: string) => readFileSync(file, "utf8"),
): string | null {
  const link = env.PASEO_MANAGED_RELEASE_LINK;
  const configuredRoot = env.PASEO_MANAGED_RELEASE_ROOT;
  if (!link && !configuredRoot) return null;
  if (!link || !configuredRoot || !path.isAbsolute(link) || !path.isAbsolute(configuredRoot))
    throw new Error("Managed release selection requires an absolute link and root");
  const root = realpathSync(configuredRoot);
  if (root !== configuredRoot) throw new Error("Managed release root must be canonical");
  const rootIdentity = protectedManagedDirectory(root);
  const parentIdentity = protectedManagedDirectory(path.dirname(link));
  const pointer = ownedReleasePointer(link);
  const pointerIdentity = pointerFingerprint(pointer);
  const linkText = readlinkSync(link);
  const release = realpathSync(link);
  if (!release.startsWith(root + path.sep))
    throw new Error("Managed release escaped its configured root");
  ReceiptSchema.parse(JSON.parse(readReceipt(path.join(release, ".installation-source.json"))));
  const worker = path.join(release, "packages/server/dist/server/server/daemon-worker.js");
  if (realpathSync(worker) !== worker || !statSync(worker).isFile())
    throw new Error("Managed worker must be a regular file inside its release");
  if (
    realpathSync(configuredRoot) !== root ||
    protectedManagedDirectory(configuredRoot) !== rootIdentity ||
    protectedManagedDirectory(path.dirname(link)) !== parentIdentity ||
    pointerFingerprint(lstatSync(link, { bigint: true })) !== pointerIdentity ||
    readlinkSync(link) !== linkText ||
    realpathSync(link) !== release
  )
    throw new Error("Managed release selection changed during resolution");
  return worker;
}

function ownedReleasePointer(link: string) {
  const pointer = lstatSync(link, { bigint: true });
  if (
    !pointer.isSymbolicLink() ||
    pointer.nlink !== 1n ||
    (process.getuid && pointer.uid !== BigInt(process.getuid()))
  )
    throw new Error("Managed release selection requires an owned symbolic link");
  return pointer;
}

function protectedManagedDirectory(directory: string) {
  const stat = lstatSync(directory, { bigint: true });
  const unsafePosix =
    process.platform !== "win32" &&
    ((stat.mode & 0o022n) !== 0n || (process.getuid && stat.uid !== BigInt(process.getuid())));
  if (realpathSync(directory) !== directory || !stat.isDirectory() || unsafePosix)
    throw new Error("Managed release selection requires protected canonical directories");
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}

function pointerFingerprint(stat: BigIntStats) {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}
