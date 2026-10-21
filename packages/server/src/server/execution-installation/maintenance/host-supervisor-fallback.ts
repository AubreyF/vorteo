import { createHash } from "node:crypto";
import { lstatSync, type BigIntStats } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import {
  assertBootstrapPathsProtected,
  inspectBootstrapReleaseArtifacts,
  readBootstrapPreparedFile,
  verifyBootstrapPreparedDependency,
  verifyBootstrapPreparedCopySource,
} from "../coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { InitialHostSupervisorPreconditionSchema } from "./native-daemon-inspection.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    const normalized = path.posix.normalize(value);
    return (
      value === normalized &&
      !path.isAbsolute(value) &&
      value !== ".." &&
      !value.startsWith("../") &&
      !value.includes("\0")
    );
  });
const entryPath = relative.refine((value) => value !== ".");
const manifestSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("initial-host-fallback-copy"),
  sourceDirectory: z.string().startsWith("/").max(4096),
  directory: z.string().startsWith("/").max(4096),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  artifactSha256: digest,
  absent: z.array(z.string().min(1).max(4096)).max(100),
  entries: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          path: entryPath,
          type: z.literal("file"),
          sha256: digest,
          mode: z.union([z.literal(0o600), z.literal(0o700)]),
          sourceIdentitySha256: digest,
        }),
        z.strictObject({
          path: entryPath,
          type: z.literal("link"),
          sourceTarget: z.string().min(1).max(4096),
          target: z.string().min(1).max(4096),
          sourceIdentitySha256: digest,
        }),
      ]),
    )
    .min(1)
    .max(100_000),
  sourceParents: z
    .array(z.strictObject({ path: relative, identitySha256: digest }))
    .min(1)
    .max(100_000),
});
type CopyManifest = z.infer<typeof manifestSchema>;
const requireMatch = (value: unknown): void => {
  if (!value) throw new BootstrapRequestConflict("Initial Host fallback copy provenance changed");
};
function identity(stat: BigIntStats): string {
  const fields = [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ];
  return createHash("sha256").update(fields.join(":")).digest("hex");
}
function contains(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}
function unique<T extends { path: string }>(items: T[]): Map<string, T> {
  const result = new Map(items.map((item) => [item.path, item]));
  requireMatch(result.size === items.length);
  return result;
}
function validateBinding(
  manifest: CopyManifest,
  release: z.infer<typeof CoordinatorBootstrapPlanSchema.shape.candidate>,
  previous: z.infer<typeof InitialHostSupervisorPreconditionSchema>,
) {
  requireMatch(
    manifest.sourceDirectory === previous.selectedRelease &&
      manifest.directory === release.directory &&
      manifest.sourceCommit === previous.sourceCommit &&
      manifest.sourceCommit === release.sourceCommit &&
      manifest.artifactSha256 === release.artifactSha256,
  );
  requireMatch(
    !contains(manifest.sourceDirectory, manifest.directory) &&
      !contains(manifest.directory, manifest.sourceDirectory),
  );
  const entries = unique(manifest.entries);
  const parents = unique(manifest.sourceParents);
  for (const file of [
    previous.supervisorEntrypoint,
    previous.workerEntrypoint,
    previous.sourceReceipt,
  ]) {
    const entry = entries.get(path.relative(manifest.sourceDirectory, file.path));
    requireMatch(entry?.type === "file" && entry.sha256 === file.sha256);
  }
  for (const entry of manifest.entries) {
    let parent = path.dirname(entry.path);
    for (;;) {
      requireMatch(parents.has(parent));
      if (parent === ".") break;
      parent = path.dirname(parent);
    }
  }
  return entries;
}
async function verifyInventory(
  directory: string,
  entries: Map<string, CopyManifest["entries"][number]>,
  check: () => void,
) {
  const seen = new Set<string>();
  let count = 0;
  async function walk(parent: string): Promise<void> {
    for (const name of await readdir(path.join(directory, parent))) {
      check();
      requireMatch(++count <= 100_000);
      const relativePath = path.join(parent, name);
      const stat = await lstat(path.join(directory, relativePath));
      if (stat.isDirectory()) await walk(relativePath);
      else {
        const entry = entries.get(relativePath);
        requireMatch(
          entry &&
            stat.isFile() === (entry.type === "file") &&
            stat.isSymbolicLink() === (entry.type === "link"),
        );
        seen.add(relativePath);
      }
    }
  }
  await walk("");
  requireMatch(seen.size === entries.size);
}
async function verifyLink(
  manifest: CopyManifest,
  entry: Extract<CopyManifest["entries"][number], { type: "link" }>,
) {
  const source = path.join(manifest.sourceDirectory, entry.path);
  const target = path.join(manifest.directory, entry.path);
  requireMatch((await lstat(source)).uid === process.getuid!());
  requireMatch(
    (await readlink(source)) === entry.sourceTarget && (await readlink(target)) === entry.target,
  );
  const sourceResolved = await realpath(source);
  const targetResolved = await realpath(target);
  requireMatch(
    contains(manifest.sourceDirectory, sourceResolved) &&
      contains(manifest.directory, targetResolved),
  );
  requireMatch(
    path.relative(manifest.sourceDirectory, sourceResolved) ===
      path.relative(manifest.directory, targetResolved),
  );
}

/** A sealed byte-copy proof, not runtime compatibility, loaded-code provenance or
 * authority to interrupt. The source inventory must be retained before copying;
 * this verifies its addressed bytes and custody again before any later admission. */
export async function inspectInitialHostFallbackCopy(input: {
  reference: { path: string; sha256: string };
  release: z.infer<typeof CoordinatorBootstrapPlanSchema.shape.candidate>;
  precondition: z.infer<typeof InitialHostSupervisorPreconditionSchema>;
  writableMountRoots: readonly string[];
  signal: AbortSignal;
}) {
  const reference = { ...input.reference };
  const release = CoordinatorBootstrapPlanSchema.shape.candidate.parse(input.release);
  const previous = InitialHostSupervisorPreconditionSchema.parse(input.precondition);
  const roots = [...input.writableMountRoots];
  const signal = input.signal;
  const deadline = performance.now() + 30_000;
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline)
      throw new BootstrapRequestConflict("Initial Host fallback verification deadline exceeded");
  };
  check();
  requireMatch(!contains(release.directory, reference.path));
  const assertReference = retainServiceFiles([reference.path, previous.selectedRelease]);
  const bytes = await readBootstrapPreparedFile(reference, roots);
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const entries = validateBinding(manifest, release, previous);
  await assertBootstrapPathsProtected([manifest.sourceDirectory, manifest.directory], roots);
  const proof = await inspectBootstrapReleaseArtifacts(release, roots, {
    signal,
    timeoutMs: deadline - performance.now(),
    maxFiles: 100_000,
    maxBytes: 2 * 1024 ** 3,
  });
  const sourceFiles = [
    ...manifest.sourceParents.map((item) => ({
      ...item,
      parent: true,
      expected: item.identitySha256,
    })),
    ...manifest.entries.map((item) => ({
      ...item,
      parent: false,
      expected: item.sourceIdentitySha256,
    })),
  ];
  const sourceAliases = new Map<string, string[]>();
  for (const entry of manifest.entries) {
    if (entry.type !== "file") continue;
    const file = path.join(manifest.sourceDirectory, entry.path);
    const stat = lstatSync(file, { bigint: true });
    const key = `${stat.dev}:${stat.ino}`;
    const aliases = sourceAliases.get(key) ?? [];
    aliases.push(file);
    sourceAliases.set(key, aliases);
  }
  const assertSource = () => {
    signal.throwIfAborted();
    for (const item of sourceFiles) {
      const stat = lstatSync(path.join(manifest.sourceDirectory, item.path), { bigint: true });
      requireMatch(identity(stat) === item.expected);
    }
  };
  assertSource();
  for (const item of manifest.sourceParents) {
    check();
    const file = path.join(manifest.sourceDirectory, item.path);
    const stat = await lstat(file, { bigint: true });
    requireMatch(
      stat.isDirectory() &&
        stat.uid === BigInt(process.getuid!()) &&
        (stat.mode & 0o022n) === 0n &&
        (await realpath(file)) === file,
    );
  }
  for (const entry of manifest.entries) {
    check();
    if (entry.type === "link") await verifyLink(manifest, entry);
    else {
      const source = path.join(manifest.sourceDirectory, entry.path);
      const target = path.join(manifest.directory, entry.path);
      const stat = lstatSync(source, { bigint: true });
      const aliases = sourceAliases.get(`${stat.dev}:${stat.ino}`) ?? [];
      await verifyBootstrapPreparedCopySource(
        { path: source, sha256: entry.sha256 },
        manifest.sourceDirectory,
        aliases,
        roots,
      );
      await verifyBootstrapPreparedDependency({ path: target, sha256: entry.sha256 }, roots);
      requireMatch(((await lstat(target)).mode & 0o777) === entry.mode);
    }
  }
  await verifyInventory(manifest.directory, entries, check);
  check();
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertReference();
    assertSource();
    proof.assertCurrent();
    signal.throwIfAborted();
  };
  assertCurrent();
  check();
  return { assertCurrent };
}
