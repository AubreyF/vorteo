import { nodeFileTrace } from "@vercel/nft";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Standalone coordinator bundle, stage 1 (design C): copy exactly the files the
// coordinator service and its runner modules load into `<release>/coordinator`,
// keeping their release-relative layout so module paths and `import.meta.url`
// children behave unchanged. Nothing consumes the bundle yet. Off unless
// VORTEO_COORDINATOR_BUNDLE=enabled.

const installation = "packages/server/dist/server/server/execution-installation";
// Read by runtime-built names in the runner contract, or launched as the recovery
// access entrypoint, so tracing cannot discover them. Keep in step with
// src/server/execution-installation/coordinator-bootstrap-runner-modules.ts; a
// test compares the two lists.
export const runtimeNamedRunnerModules = [
  "coordinator-bootstrap-runner.js",
  "coordinator-bootstrap-maintenance-service-runner.js",
  "coordinator-bootstrap-maintenance-service-claim.js",
  "coordinator-bootstrap-maintenance-service-binding.js",
  "coordinator-bootstrap-maintenance-recovery-binding.js",
  "coordinator-bootstrap-maintenance-service-native.js",
  "coordinator-bootstrap-maintenance-recovery-native.js",
  "coordinator-bootstrap-journal.js",
  "maintenance/service-admission.js",
  "lifecycle-journal.js",
  "../private-files.js",
  "coordinator-bootstrap-maintenance-recovery-access.js",
];
// Every runtime-named module is traced as an entrypoint, so its own imports ship too.
export const coordinatorBundleEntries = [
  ...new Set([
    `${installation}/main.js`,
    ...runtimeNamedRunnerModules.map((name) => path.posix.normalize(`${installation}/${name}`)),
  ]),
];
// Read by path rather than imported. The receipt is written after build:server,
// so the bundle is built after it.
export const coordinatorBundleExtras = [
  ".installation-source.json",
  "scripts/run-coordinator-owner.py",
  "scripts/verify-coordinator-owner.py",
];
// ws loads these optional native accelerators inside try/catch; their absence is reviewed.
const optionalModules = {
  bufferutil: "node_modules/ws/lib/buffer-util.js",
  "utf-8-validate": "node_modules/ws/lib/validation.js",
};
const artifactModule =
  "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-artifact.js";
const run = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

export function coordinatorBundleEnabled(environment = process.env) {
  return environment.VORTEO_COORDINATOR_BUNDLE === "enabled";
}

function classifyWarnings(root, warnings) {
  const reviewed = [];
  for (const warning of warnings) {
    const match = /^Failed to resolve dependency "([^"]+)":/.exec(warning.message);
    const importer =
      match && Object.hasOwn(optionalModules, match[1]) ? optionalModules[match[1]] : null;
    if (!importer || !warning.message.includes(path.join(root, importer)))
      throw new Error(`Coordinator bundle has an unclassified trace warning: ${warning.message}`);
    reviewed.push(match[1]);
  }
  return reviewed.sort();
}

async function copyEntry(root, output, name) {
  if (path.isAbsolute(name) || name.split(path.sep).includes("..") || path.normalize(name) !== name)
    throw new Error(`Coordinator closure reaches outside its release: ${name}`);
  const source = path.join(root, name);
  const destination = path.join(output, name);
  const before = await lstat(source);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  if (before.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    return null;
  }
  if (before.isSymbolicLink()) {
    const target = await readlink(source);
    if (path.isAbsolute(target))
      throw new Error(`Coordinator closure has an absolute link: ${name}`);
    await symlink(target, destination);
    return { path: name, type: "link", target };
  }
  if (!before.isFile()) throw new Error(`Coordinator closure has a non-runtime file: ${name}`);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  // Never widen access; drop group and other write like every prepared release.
  await chmod(destination, before.mode & 0o755);
  const digest = sha256(await readFile(source));
  if (sha256(await readFile(destination)) !== digest)
    throw new Error(`Coordinator bundle copy changed: ${name}`);
  return { path: name, type: "file", sha256: digest, executable: (before.mode & 0o100) !== 0 };
}

/** Imports the bundled verifier with reads confined to the bundle. Its module
 * graph must resolve entirely inside, and it digests the bundle itself. */
async function selfCheck(output) {
  const module = pathToFileURL(path.join(output, artifactModule)).href;
  // CommonJS eval: workers inherit execArgv and refuse --input-type.
  const source = `(async () => {
    const { digestBootstrapArtifact } = await import(${JSON.stringify(module)});
    process.stdout.write(await digestBootstrapArtifact(${JSON.stringify(output)}));
  })().catch((error) => { process.stderr.write(String(error?.stack ?? error)); process.exit(1); });`;
  try {
    const { stdout } = await run(
      process.execPath,
      ["--permission", `--allow-fs-read=${output}`, "--allow-worker", "--eval", source],
      { env: { PATH: "/usr/bin:/bin" }, timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    if (!/^[a-f0-9]{64}$/.test(stdout)) throw new Error("Unexpected self-check output");
    return stdout;
  } catch (error) {
    throw new Error("Coordinator bundle does not run self-contained", { cause: error });
  }
}

export async function buildCoordinatorBundle(release, output = path.join(release, "coordinator")) {
  const root = await realpath(release);
  if (existsSync(output)) throw new Error("Coordinator bundle output already exists");
  for (const name of [...coordinatorBundleEntries, ...coordinatorBundleExtras])
    if (!existsSync(path.join(root, name)))
      throw new Error(`Coordinator bundle input is missing: ${name}`);
  const traced = await nodeFileTrace(
    coordinatorBundleEntries.map((name) => path.join(root, name)),
    {
      base: root,
      // File references keep assets loaded through new URL(..., import.meta.url).
      analysis: { computeFileReferences: true, emitGlobs: false, evaluatePureExpressions: true },
    },
  );
  const warnings = classifyWarnings(root, traced.warnings);
  await mkdir(output, { mode: 0o755 });
  const target = await realpath(output);
  const files = [];
  for (const name of [...new Set([...traced.fileList, ...coordinatorBundleExtras])].sort()) {
    const entry = await copyEntry(root, target, name);
    if (entry) files.push(entry);
  }
  for (const entry of files.filter((file) => file.type === "link")) {
    const resolved = await realpath(path.join(target, entry.path));
    if (!inside(target, resolved))
      throw new Error(`Coordinator bundle link escapes the bundle: ${entry.path}`);
  }
  await writeFile(
    path.join(target, "bundle.json"),
    JSON.stringify({
      version: 1,
      purpose: "coordinator-bundle",
      entries: coordinatorBundleEntries,
      extras: coordinatorBundleExtras,
      warnings,
      files,
    }) + "\n",
    { mode: 0o644 },
  );
  const artifactSha256 = await selfCheck(target);
  return { output: target, files: files.length, artifactSha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (coordinatorBundleEnabled()) {
    const release = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    const bundle = await buildCoordinatorBundle(release);
    console.log(
      `Coordinator bundle: ${bundle.files} entries, artifact ${bundle.artifactSha256}, ${bundle.output}`,
    );
  }
}
