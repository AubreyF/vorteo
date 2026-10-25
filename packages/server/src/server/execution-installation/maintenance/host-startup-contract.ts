import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import {
  assertBootstrapPathsProtected,
  readProtectedDocument,
  verifyBootstrapPreparedDependency,
} from "../coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";

export const initialHostModuleEntries = [
  "packages/server/dist/scripts/supervisor-entrypoint.js",
  "packages/server/dist/server/server/daemon-worker.js",
  "packages/cli/dist/index.js",
  "packages/server/dist/server/terminal/terminal-worker-process.js",
  "packages/server/dist/server/server/speech/providers/local/worker-process.js",
] as const;
export const initialHostModuleContractPath =
  "packages/server/dist/server/server/execution-installation/maintenance/host-startup-contract.json";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (name) =>
      path.posix.normalize(name) === name &&
      !path.isAbsolute(name) &&
      name !== "." &&
      name !== ".." &&
      !name.startsWith("../") &&
      !name.includes("\0"),
  );
const schema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("initial-host-module-contract"),
  platform: z.literal("darwin"),
  arch: z.enum(["arm64", "x64"]),
  entries: z.array(relative).length(initialHostModuleEntries.length),
  files: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          path: relative,
          type: z.literal("file"),
          sha256: digest,
          executable: z.boolean(),
        }),
        z.strictObject({
          path: relative,
          type: z.literal("link"),
          target: z.string().min(1).max(4096),
        }),
      ]),
    )
    .min(initialHostModuleEntries.length)
    .max(8192),
  absent: z.array(relative).max(32768),
  directories: z.array(relative.or(z.literal("."))).max(8192),
  warnings: z
    .array(
      z.strictObject({
        module: z.enum(["bufferutil", "utf-8-validate", "pnpapi"]),
        importer: relative,
        sha256: digest,
      }),
    )
    .max(3),
});
type ModuleFile = z.infer<typeof schema>["files"][number];
interface ModuleTree {
  root: string;
  files: ModuleFile[];
}
function requireMatch(value: unknown): asserts value {
  if (!value) throw new BootstrapRequestConflict("Initial Host module contract changed");
}
function identity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.gid,
    stat.mode,
    stat.size,
    stat.nlink,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}
/**
 * A directory outside a release tree is pinned like service custody pins directories:
 * by device, inode, owner, group and mode, not by size, link count or timestamps. Those
 * change whenever any sibling entry is written, which on the Host includes the home
 * folder's dotfiles. Absence below it is proven directly, before and after.
 */
function directoryIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(":");
}
function within(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}
function retainTree(tree: ModuleTree): () => void {
  const assertions: Array<() => void> = [];
  const regular = tree.files
    .filter((item) => item.type === "file")
    .map((item) => path.join(tree.root, item.path));
  // Keep the existing per-proof custody limit; each small group includes its
  // ancestors and the final assertion composes every group.
  for (let offset = 0; offset < regular.length; offset += 16)
    assertions.push(retainServiceFiles(regular.slice(offset, offset + 16)));
  for (const entry of tree.files) {
    if (entry.type !== "link") continue;
    const file = path.join(tree.root, entry.path);
    const stat = lstatSync(file, { bigint: true });
    requireMatch(stat.isSymbolicLink() && stat.uid === BigInt(process.getuid!()));
    const expected = identity(stat);
    const assertParent = retainServiceFiles([path.dirname(file)]);
    assertions.push(() => {
      assertParent();
      requireMatch(
        identity(lstatSync(file, { bigint: true })) === expected &&
          readlinkSync(file) === entry.target,
      );
    });
  }
  return () => {
    for (const assertion of assertions) assertion();
  };
}
function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
function requireAbsent(file: string): void {
  try {
    lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new BootstrapRequestConflict("Initial Host module lookup became present");
}
/** Prove `file` absent now and at each assertion. The nearest existing ancestor keeps
 * its full identity inside `root`; above it, only its directory identity. */
function retainMissing(file: string, root: string): () => void {
  requireAbsent(file);
  let parent = path.dirname(file);
  for (;;) {
    try {
      lstatSync(parent);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const next = path.dirname(parent);
      requireMatch(next !== parent);
      parent = next;
    }
  }
  const assertParent = retainServiceFiles([parent]);
  const stat = lstatSync(parent, { bigint: true });
  const pin = within(root, parent) || !stat.isDirectory() ? identity : directoryIdentity;
  const expected = pin(stat);
  return () => {
    assertParent();
    requireMatch(pin(lstatSync(parent, { bigint: true })) === expected);
    requireAbsent(file);
    requireMatch(pin(lstatSync(parent, { bigint: true })) === expected);
  };
}
function retainResolution(root: string, absent: string[], directories: string[]): () => void {
  const assertions = absent.map((file) => retainMissing(path.join(root, file), root));
  for (const file of directories) {
    const absolute = path.join(root, file);
    requireMatch(lstatSync(absolute).isDirectory() && realpathSync(absolute) === absolute);
    assertions.push(retainServiceFiles([absolute]));
  }
  let parent = path.dirname(root);
  for (;;) {
    assertions.push(retainMissing(path.join(parent, "node_modules"), root));
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return () => {
    for (const assertion of assertions) assertion();
  };
}
async function verifyTree(tree: ModuleTree, roots: readonly string[], check: () => void) {
  for (const entry of tree.files) {
    check();
    const file = path.join(tree.root, entry.path);
    if (entry.type === "file") {
      await verifyBootstrapPreparedDependency({ path: file, sha256: entry.sha256 }, roots);
      requireMatch(((lstatSync(file).mode & 0o100) !== 0) === entry.executable);
    } else {
      await assertBootstrapPathsProtected([file], roots);
      const resolved = await realpath(file);
      requireMatch(
        !path.isAbsolute(entry.target) &&
          resolved.startsWith(tree.root + path.sep) &&
          (await readlink(file)) === entry.target,
      );
    }
  }
}
/** Module closure only. The caller must bind referenceRoot to its own verified
 * executing build. Runtime assets, external configuration, interruption and native
 * readiness remain separate proofs; this API returns no effect authority. */
export async function inspectInitialHostModuleContract(input: {
  referenceRoot: string;
  candidateRoot: string;
  writableMountRoots: readonly string[];
  signal: AbortSignal;
}) {
  const referenceRoot = path.resolve(input.referenceRoot);
  const candidateRoot = path.resolve(input.candidateRoot);
  const roots = [...input.writableMountRoots];
  const signal = input.signal;
  const deadline = performance.now() + 30_000;
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline)
      throw new BootstrapRequestConflict("Initial Host module contract deadline exceeded");
  };
  check();
  await assertBootstrapPathsProtected([referenceRoot, candidateRoot], roots);
  const referenceFile = path.join(referenceRoot, initialHostModuleContractPath);
  const candidateFile = path.join(candidateRoot, initialHostModuleContractPath);
  const assertDocuments = retainServiceFiles([referenceFile, candidateFile]);
  const bytes = await readProtectedDocument(referenceFile);
  const manifest = schema.parse(JSON.parse(bytes.toString("utf8")));
  requireMatch(
    manifest.arch === process.arch &&
      manifest.entries.every((entry, index) => entry === initialHostModuleEntries[index]),
  );
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  requireMatch(
    files.size === manifest.files.length &&
      initialHostModuleEntries.every((entry) => files.get(entry)?.type === "file") &&
      !files.has(initialHostModuleContractPath),
  );
  for (const warning of manifest.warnings) {
    const importer = files.get(warning.importer);
    requireMatch(importer?.type === "file" && importer.sha256 === warning.sha256);
  }
  const reference = { root: referenceRoot, files: manifest.files };
  const candidate = { root: candidateRoot, files: manifest.files };
  const assertReference = retainTree(reference);
  const assertCandidate = retainTree(candidate);
  const assertReferenceResolution = retainResolution(
    referenceRoot,
    manifest.absent,
    manifest.directories,
  );
  const assertCandidateResolution = retainResolution(
    candidateRoot,
    manifest.absent,
    manifest.directories,
  );
  const candidateBytes = await readProtectedDocument(candidateFile);
  requireMatch(
    createHash("sha256").update(candidateBytes).digest("hex") ===
      createHash("sha256").update(bytes).digest("hex"),
  );
  await verifyTree(reference, roots, check);
  await verifyTree(candidate, roots, check);
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertDocuments();
    assertReference();
    assertCandidate();
    assertReferenceResolution();
    assertCandidateResolution();
    signal.throwIfAborted();
  };
  assertCurrent();
  check();
  return { assertCurrent };
}
