import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PACKAGED_CLAUDE_VERSION = "2.1.284";
const packageName = "@anthropic-ai/claude-code";
const require = createRequire(import.meta.url);
const Manifest = z.object({
  name: z.string(),
  version: z.literal(PACKAGED_CLAUDE_VERSION),
  bin: z.object({ claude: z.literal("bin/claude.exe") }).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
});

interface PackageRuntime {
  platform: NodeJS.Platform;
  arch: string;
  libc?: "glibc" | "musl";
  resolvePackage: (name: string) => string;
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Filesystem-only verification. Package installation scripts never run here. */
export async function resolvePackagedClaudeCli(runtime: PackageRuntime): Promise<string> {
  const { platform, arch, libc, resolvePackage } = runtime;
  if (
    !["darwin", "linux", "win32"].includes(platform) ||
    !["arm64", "x64"].includes(arch) ||
    (platform === "linux" && !libc)
  ) {
    throw new Error("Packaged Claude CLI platform is unsupported");
  }
  const suffix = platform === "linux" && libc === "musl" ? "-musl" : "";
  const nativeName = `${packageName}-${platform}-${arch}${suffix}`;
  const mainFile = resolvePackage(`${packageName}/package.json`);
  const main = Manifest.parse(JSON.parse(await readFile(mainFile, "utf8")));
  if (
    main.name !== packageName ||
    !main.bin ||
    main.optionalDependencies?.[nativeName] !== PACKAGED_CLAUDE_VERSION
  ) {
    throw new Error("Packaged Claude CLI dependency pin does not match this release");
  }
  const nativeFile = resolvePackage(`${nativeName}/package.json`);
  const native = Manifest.parse(JSON.parse(await readFile(nativeFile, "utf8")));
  if (native.name !== nativeName || !native.os?.includes(platform) || !native.cpu?.includes(arch)) {
    throw new Error("Packaged Claude CLI platform payload does not match this runtime");
  }
  if (platform === "linux" && !native.libc?.includes(libc!)) {
    throw new Error("Packaged Claude CLI libc payload does not match this runtime");
  }
  const installed = path.join(path.dirname(mainFile), main.bin.claude);
  const payload = path.join(
    path.dirname(nativeFile),
    platform === "win32" ? "claude.exe" : "claude",
  );
  const [installedPath, payloadPath] = await Promise.all([
    containedExecutable(installed, path.dirname(mainFile)),
    containedExecutable(payload, path.dirname(nativeFile)),
  ]);
  await verifyInstalledPayload(installedPath, payloadPath);
  return installedPath;
}

async function containedExecutable(executable: string, directory: string): Promise<string> {
  const [resolved, root] = await Promise.all([realpath(executable), realpath(directory)]);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Packaged Claude CLI executable escaped its package");
  }
  return resolved;
}

async function verifyInstalledPayload(installed: string, payload: string): Promise<void> {
  const [installedStat, payloadStat] = await Promise.all([stat(installed), stat(payload)]);
  if (!installedStat.isFile() || !payloadStat.isFile() || payloadStat.size === 0) {
    throw new Error("Packaged Claude CLI executable is missing");
  }
  await access(installed, constants.X_OK);
  // npm's postinstall hardlinks or copies this exact payload. Reject its fallback
  // wrapper, partial installation, or a bin from a different platform/version.
  if (
    installedStat.size !== payloadStat.size ||
    ((installedStat.dev !== payloadStat.dev || installedStat.ino !== payloadStat.ino) &&
      (await digest(installed)) !== (await digest(payload)))
  ) {
    throw new Error("Packaged Claude CLI postinstall payload does not match");
  }
}

let managed = false;
let selection: Promise<string> | undefined;
let selectedCommand: string | undefined;

/** Called by daemon-worker with its captured flag, after deleting the env marker. */
export function initializePackagedClaudeCli(managedWorker: boolean): void {
  managed = managedWorker;
  selection = undefined;
  selectedCommand = undefined;
}

export async function managedClaudeCli(): Promise<string | null> {
  if (!managed) return null;
  selection ??= resolveReleasePackage()
    .then((resolvePackage) =>
      resolvePackagedClaudeCli({
        platform: process.platform,
        arch: process.arch,
        libc: runtimeLibc(),
        resolvePackage,
      }),
    )
    .then((command) => {
      selectedCommand = command;
      return command;
    });
  return selection;
}

// Availability must not run a hidden --version probe for this validated pin.
export function isPackagedClaudeCommand(command: string): boolean {
  return managed && selectedCommand === command;
}

function runtimeLibc(): "glibc" | "musl" | undefined {
  if (process.platform !== "linux") return undefined;
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  return report.header.glibcVersionRuntime ? "glibc" : "musl";
}

// Resolve only dependencies belonging to this server release, never a global or
// ancestor installation accidentally found by Node's normal lookup fallback.
async function resolveReleasePackage(): Promise<(name: string) => string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (path.dirname(directory) !== directory) {
    let manifest: { name?: string; dependencies?: Record<string, string> } | undefined;
    try {
      manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (manifest?.name === "@getpaseo/server") {
      if (manifest.dependencies?.[packageName] !== PACKAGED_CLAUDE_VERSION) {
        throw new Error("Server release does not pin the managed Claude CLI");
      }
      const roots = [path.join(directory, "node_modules")];
      if (
        path.basename(directory) === "server" &&
        path.basename(path.dirname(directory)) === "packages"
      ) {
        roots.push(path.resolve(directory, "../../node_modules"));
      }
      return (name) => {
        const resolved = require.resolve(name);
        if (!roots.some((root) => resolved.startsWith(`${root}${path.sep}`))) {
          throw new Error("Managed Claude CLI resolved outside its server release");
        }
        return resolved;
      };
    }
    directory = path.dirname(directory);
  }
  throw new Error("Managed Claude CLI server release is missing");
}
