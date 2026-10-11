import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigSchema } from "./config.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const FileCommitment = z.strictObject({
  path: z.string().startsWith("/"),
  size: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  sha256: Digest,
});
const Manifest = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  artifact: FileCommitment,
  configuration: FileCommitment,
});
export interface LoadedReleaseIdentity {
  version: 1;
  installationId: string;
  sourceCommit: string;
  manifestSha256: string;
  artifactSha256: string;
  configSha256: string;
}
export interface ReleasePaths {
  manifestFile: string;
  artifactFile: string;
  configFile: string;
}
interface FileIdentity {
  identity: string;
  uid: number;
  mode: number;
  links: number;
  size: number;
  kind: "file" | "directory" | "other";
}
export interface ReleaseFileSystem {
  uid(): number;
  realpath(file: string): string;
  inspect(file: string): FileIdentity;
  open(file: string): number;
  inspectOpen(fd: number): FileIdentity;
  read(fd: number, buffer: Buffer): number;
  close(fd: number): void;
}
function fileIdentity(stat: BigIntStats): FileIdentity {
  let kind: FileIdentity["kind"] = "other";
  if (stat.isFile()) kind = "file";
  else if (stat.isDirectory()) kind = "directory";
  const identity = [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode];
  // Sibling changes do not change directory authority or path identity.
  if (kind !== "directory") identity.push(stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs);
  return {
    identity: identity.join(":"),
    uid: Number(stat.uid),
    mode: Number(stat.mode),
    links: Number(stat.nlink),
    size: Number(stat.size),
    kind,
  };
}
export const releaseFileSystem: ReleaseFileSystem = {
  uid: () => {
    if (!process.getuid) throw new ReleaseManifestError("Managed releases require Unix ownership");
    return process.getuid();
  },
  realpath: realpathSync,
  inspect: (file) => fileIdentity(lstatSync(file, { bigint: true })),
  open: (file) => openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  inspectOpen: (fd) => fileIdentity(fstatSync(fd, { bigint: true })),
  read: (fd, buffer) => readSync(fd, buffer, 0, buffer.length, null),
  close: closeSync,
};
export class ReleaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseManifestError";
  }
}

/** Startup snapshot only, not account authority or a substitute for coordinator
 * process inspection. The coordinator must protect the selected bundle before
 * Node loads it and exclude paths writable through guest mounts or ACL grants. */
export function loadManagedRelease(files: ReleasePaths, fs: ReleaseFileSystem = releaseFileSystem) {
  const uid = fs.uid();
  const observed = new Map<string, string>();
  function inspect(file: string) {
    const stat = fs.inspect(file);
    const previous = observed.get(file);
    if (previous !== undefined && previous !== stat.identity)
      throw new ReleaseManifestError("Release selection changed during verification");
    observed.set(file, stat.identity);
    return stat;
  }
  function protectedPath(file: string) {
    if (!path.isAbsolute(file) || path.normalize(file) !== file || fs.realpath(file) !== file)
      throw new ReleaseManifestError("Release paths must be canonical without symlinks");
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      const stat = inspect(parent);
      const trustedOwner = stat.uid === uid || stat.uid === 0;
      if (stat.kind !== "directory" || !trustedOwner || (stat.mode & 0o022) !== 0)
        throw new ReleaseManifestError("Release ancestry must have protected ownership and mode");
      if (parent === path.dirname(parent)) break;
    }
  }
  function read(file: string, options: { limit: number; private: boolean; retain: boolean }) {
    protectedPath(file);
    const before = inspect(file);
    const unsafeMode = options.private ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0;
    if (before.kind !== "file" || before.links !== 1 || before.uid !== uid || unsafeMode)
      throw new ReleaseManifestError(
        "Release file must be singly linked with protected ownership and mode",
      );
    if (before.size <= 0 || before.size > options.limit)
      throw new ReleaseManifestError("Release file exceeds its size bound");
    const fd = fs.open(file);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (fs.inspectOpen(fd).identity !== before.identity)
        throw new ReleaseManifestError("Release file changed before open");
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const count = fs.read(fd, buffer);
        if (count === 0) break;
        size += count;
        if (size > before.size || size > options.limit)
          throw new ReleaseManifestError("Release file grew during verification");
        const bytes = buffer.subarray(0, count);
        hash.update(bytes);
        if (options.retain) chunks.push(Buffer.from(bytes));
      }
      if (size !== before.size || fs.inspectOpen(fd).identity !== before.identity)
        throw new ReleaseManifestError("Release file changed during read");
      inspect(file);
      return { size, sha256: hash.digest("hex"), bytes: Buffer.concat(chunks) };
    } finally {
      fs.close(fd);
    }
  }
  const document = read(files.manifestFile, { limit: 64 * 1024, private: true, retain: true });
  const manifest = Manifest.parse(JSON.parse(document.bytes.toString("utf8")));
  if (
    manifest.artifact.path !== files.artifactFile ||
    manifest.configuration.path !== files.configFile
  )
    throw new ReleaseManifestError(
      "Manifest does not bind the running entrypoint and selected configuration",
    );
  if (new Set([files.manifestFile, files.artifactFile, files.configFile]).size !== 3)
    throw new ReleaseManifestError("Release files must be distinct");
  const artifact = read(files.artifactFile, {
    limit: 64 * 1024 * 1024,
    private: false,
    retain: false,
  });
  const configuration = read(files.configFile, { limit: 1024 * 1024, private: true, retain: true });
  if (artifact.sha256 !== manifest.artifact.sha256 || artifact.size !== manifest.artifact.size)
    throw new ReleaseManifestError("Release artifact commitment does not match selected bytes");
  if (
    configuration.sha256 !== manifest.configuration.sha256 ||
    configuration.size !== manifest.configuration.size
  )
    throw new ReleaseManifestError(
      "Release configuration commitment does not match selected bytes",
    );
  // Parse the verified buffer, never reopen the config pathname after hashing.
  const config = ConfigSchema.parse(JSON.parse(configuration.bytes.toString("utf8")));
  for (const file of observed.keys()) inspect(file);
  const identity: LoadedReleaseIdentity = {
    version: 1,
    installationId: manifest.installationId,
    sourceCommit: manifest.sourceCommit,
    manifestSha256: document.sha256,
    artifactSha256: artifact.sha256,
    configSha256: configuration.sha256,
  };
  return { config, identity };
}
