import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileTrace } from "@vercel/nft";

const contractPath =
  "packages/server/dist/server/server/execution-installation/maintenance/host-startup-contract.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identify = (value) =>
  [
    value.dev,
    value.ino,
    value.mode,
    value.uid,
    value.gid,
    value.size,
    value.nlink,
    value.mtimeNs,
    value.ctimeNs,
  ].join(":");
const missing = (error) => error.code === "ENOENT" || error.code === "ENOTDIR";
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function ancestorModules(root) {
  const result = [];
  let current = path.dirname(root);
  for (;;) {
    result.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}
async function requireAbsent(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  throw new Error("Host module resolution gained an unreviewed path");
}
async function sample(file) {
  let target;
  try {
    target = await stat(file);
  } catch (error) {
    if (!missing(error)) throw error;
    await requireAbsent(file);
    return { kind: "missing", fingerprint: null, canonical: null, stat: null };
  }
  const own = await lstat(file, { bigint: true });
  const followed = await stat(file, { bigint: true });
  const canonical = await realpath(file);
  let kind;
  if (target.isFile()) kind = "file";
  else if (target.isDirectory()) kind = "directory";
  else throw new Error("Host module resolution encountered a non-runtime path");
  return {
    kind,
    fingerprint: identify(own) + ":" + identify(followed) + ":" + canonical,
    canonical,
    stat: target,
  };
}
async function canonicalMissing(file) {
  const suffix = [];
  let current = file;
  for (;;) {
    try {
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if (!missing(error)) throw error;
      // A dangling link is not interchangeable with an absent lookup path.
      await requireAbsent(current);
      suffix.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current)
        throw new Error("Host module resolution lost its root", { cause: error });
      current = parent;
    }
  }
}

/** NFT consumes these real filesystem ports. Tests exercise the same retained
 * resolution evidence without launching or executing any target module. */
export function createHostModuleTraceFilesystem(value) {
  const root = path.resolve(value);
  const probes = new Map();
  const reads = new Map();
  const external = ancestorModules(root);
  function probe(file) {
    let pending = probes.get(file);
    if (!pending) {
      if (probes.size >= 32768) throw new Error("Host module resolution exceeds its lookup bound");
      pending = sample(file);
      probes.set(file, pending);
    }
    return pending;
  }
  async function tracedStat(file) {
    return (await probe(file)).stat;
  }
  async function tracedReadlink(file) {
    const before = await probe(file);
    if (before.kind === "missing") return null;
    const own = await lstat(file, { bigint: true });
    if (!own.isSymbolicLink()) return null;
    const target = await readlink(file);
    if (before.fingerprint !== (await sample(file)).fingerprint)
      throw new Error("Host workspace link changed during tracing");
    return target;
  }
  async function tracedRead(file) {
    const before = await probe(file);
    if (before.kind !== "file") return null;
    if (!inside(root, before.canonical))
      throw new Error("Host module contract read outside its build root");
    const bytes = await readFile(file);
    const after = await sample(file);
    if (before.fingerprint !== after.fingerprint)
      throw new Error("Host module changed during tracing");
    const previous = reads.get(before.canonical);
    const sha256 = hash(bytes);
    if (previous && previous !== sha256) throw new Error("Host module changed between trace reads");
    reads.set(before.canonical, sha256);
    return bytes;
  }
  async function assertCurrent() {
    for (const file of external) await requireAbsent(file);
    for (const [file, pending] of probes) {
      const before = await pending;
      const current = await sample(file);
      if (before.kind !== current.kind || before.fingerprint !== current.fingerprint)
        throw new Error("Host module resolution changed during tracing");
    }
  }
  async function finish() {
    await assertCurrent();
    const absent = new Set();
    const directories = new Set();
    const files = new Set(reads.keys());
    for (const [file, pending] of probes) {
      const observed = await pending;
      if (!inside(root, file)) {
        if (observed.kind === "file")
          throw new Error("Host module resolution found external metadata");
        continue;
      }
      if (observed.kind === "missing") {
        const canonical = await canonicalMissing(file);
        if (!inside(root, canonical)) throw new Error("Host module lookup escaped its root");
        absent.add(path.relative(root, canonical));
      } else if (observed.kind === "directory")
        directories.add(path.relative(root, observed.canonical) || ".");
      else files.add(observed.canonical);
    }
    const compact = [];
    for (const file of [...absent].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
      if (!compact.some((parent) => file.startsWith(parent + path.sep))) compact.push(file);
    }
    return {
      absent: compact.sort(),
      directories: [...directories].sort(),
      files: [...files],
      reads,
      assertCurrent,
    };
  }
  return { stat: tracedStat, readFile: tracedRead, readlink: tracedReadlink, finish };
}

async function collectContractFiles(root, names, reads) {
  const files = [];
  for (const name of [...names].sort()) {
    if (
      path.isAbsolute(name) ||
      name.split("/").includes("..") ||
      path.posix.normalize(name) !== name ||
      name === contractPath
    )
      throw new Error("Host module contract contains an escaping or recursive path");
    const file = path.join(root, name);
    const before = await lstat(file, { bigint: true });
    if (before.isSymbolicLink()) {
      const target = await readlink(file);
      if (path.isAbsolute(target) || !inside(root, await realpath(file)))
        throw new Error("Host module contract contains an external workspace link");
      files.push({ path: name, type: "link", target });
    } else {
      if (!before.isFile() || (await realpath(file)) !== file)
        throw new Error("Host module contract contains a noncanonical file");
      const bytes = await readFile(file);
      const tracedHash = reads.get(file);
      if (tracedHash && tracedHash !== hash(bytes))
        throw new Error("Host module changed after tracing");
      files.push({
        path: name,
        type: "file",
        sha256: hash(bytes),
        executable: (before.mode & 0o100n) !== 0n,
      });
    }
    if (identify(before) !== identify(await lstat(file, { bigint: true })))
      throw new Error("Host module changed during contract generation");
  }
  return files;
}

async function buildContract(root) {
  const output = path.join(root, contractPath);
  // Initial native Host migration is macOS-only. A Dev build must not retain
  // a stale contract copied from a different platform.
  if (process.platform !== "darwin") {
    await rm(output, { force: true });
    return;
  }
  const entries = [
    "packages/server/dist/scripts/supervisor-entrypoint.js",
    "packages/server/dist/server/server/daemon-worker.js",
    "packages/cli/dist/index.js",
    "packages/server/dist/server/terminal/terminal-worker-process.js",
    "packages/server/dist/server/server/speech/providers/local/worker-process.js",
  ];
  const optional = {
    bufferutil: {
      importer: "node_modules/ws/lib/buffer-util.js",
      sha256: "8b0a45739132f82e25ea13163780abf547ccfe989267f3eb7abb475beec92da3",
    },
    "utf-8-validate": {
      importer: "node_modules/ws/lib/validation.js",
      sha256: "41ce8e83d0d434132e1704895fedb91f6703a701b42d91c80954ab29b2845593",
    },
    pnpapi: {
      importer: "packages/server/node_modules/esbuild/lib/main.js",
      sha256: "0d1241812c443111d39475dfc66836003e9ef8b87e54d990dd67df29d20010e1",
    },
  };
  const ports = createHostModuleTraceFilesystem(root);
  const traced = await nodeFileTrace(
    entries.map((name) => path.join(root, name)),
    {
      base: root,
      stat: ports.stat,
      readFile: ports.readFile,
      readlink: ports.readlink,
      analysis: { computeFileReferences: false, emitGlobs: false, evaluatePureExpressions: true },
    },
  );
  const resolution = await ports.finish();
  const warnings = [];
  for (const warning of traced.warnings) {
    const match = /^Failed to resolve dependency "([^"]+)":/.exec(warning.message);
    const reviewed = match && Object.hasOwn(optional, match[1]) ? optional[match[1]] : null;
    if (!reviewed || !warning.message.includes(path.join(root, reviewed.importer)))
      throw new Error("Host module contract has an unclassified trace warning");
    if (hash(await readFile(path.join(root, reviewed.importer))) !== reviewed.sha256)
      throw new Error("Host module contract optional-load implementation changed");
    warnings.push({ module: match[1], importer: reviewed.importer, sha256: reviewed.sha256 });
  }
  const names = new Set([
    ...traced.fileList,
    ...resolution.files.map((file) => path.relative(root, file)),
  ]);
  const files = await collectContractFiles(root, names, resolution.reads);
  const directories = resolution.directories.filter(
    (directory) =>
      !files.some((file) => directory === "." || file.path.startsWith(directory + path.sep)),
  );
  const bytes =
    JSON.stringify({
      version: 1,
      purpose: "initial-host-module-contract",
      platform: process.platform,
      arch: process.arch,
      entries,
      files,
      warnings,
      absent: resolution.absent,
      directories,
    }) + "\n";
  if (files.length > 8192 || Buffer.byteLength(bytes) > 1024 * 1024)
    throw new Error("Host module contract exceeds its bounded document size");
  await resolution.assertCurrent();
  await writeFile(output, bytes, { mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildContract(path.resolve(fileURLToPath(new URL("../../../", import.meta.url))));
