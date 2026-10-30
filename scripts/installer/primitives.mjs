// File, process and path helpers shared by the installer engine and
// scripts/install-execution-host.mjs. Everything here is free of installation policy.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isInsideFolder } from "../lib/projects-folder.mjs";

const execute = promisify(execFile);

export function within(file, directory) {
  return (
    file === directory ||
    file.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep)
  );
}

export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Writes atomically with mode 600, creating private parents. */
export function privateWrite(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

export function writeJson(file, data) {
  privateWrite(file, JSON.stringify(data, null, 2) + "\n");
}

// Commands still running, so a stopped installer never leaves a build or Docker step behind.
const running = new Set();

/** Runs a command without a shell and returns its trimmed standard output. */
export async function run(command, args, options = {}) {
  const pending = execute(command, args, {
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  running.add(pending.child);
  try {
    return (await pending).stdout.trim();
  } finally {
    running.delete(pending.child);
  }
}

/** Stops every command this process started; called when the installer itself is stopped. */
export function stopRunning(signal = "SIGTERM") {
  for (const child of running) child.kill(signal);
}

/** Runs a long build step, keeping its output in a private log instead of the terminal. */
export async function build(command, args, cwd, log, environment = {}, runCommand = run) {
  try {
    privateWrite(
      log,
      await runCommand(command, args, {
        cwd,
        timeout: 30 * 60_000,
        env: { ...process.env, ...environment },
      }),
    );
  } catch (error) {
    privateWrite(log, `${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    throw new Error(`Build failed; inspect ${log}`, { cause: error });
  }
}

/** Host paths that any container, running or stopped, can write through a bind mount. */
export async function writableBindRoots(docker, runCommand = run) {
  const ids = (await runCommand(docker, ["ps", "-aq"])).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const containers = JSON.parse(await runCommand(docker, ["inspect", ...ids]));
  return containers.flatMap((container) =>
    container.Mounts.filter((mount) => mount.Type === "bind" && mount.RW).map(
      (mount) => mount.Source,
    ),
  );
}

export function canonicalFuturePath(file) {
  const absolute = path.resolve(file);
  if (existsSync(absolute)) return realpathSync(absolute);
  return path.join(canonicalFuturePath(path.dirname(absolute)), path.basename(absolute));
}

export function assertProtectedPaths(files, mountRoots) {
  const roots = mountRoots.map(canonicalFuturePath);
  for (const file of files) {
    const resolved = canonicalFuturePath(file);
    if (roots.some((root) => within(resolved, root) || within(root, resolved)))
      throw new Error(
        `Protected installation path is exposed through a writable container bind: ${file}`,
      );
  }
}

/**
 * The Projects folder is guest-writable, so the Host's runtime, state and install source
 * must never live inside it.
 */
export function assertProjectsFolderSeparate(folder, protectedPaths) {
  for (const protectedPath of protectedPaths) {
    if (protectedPath && isInsideFolder(folder, protectedPath))
      throw new Error(
        `${protectedPath} is inside the Projects folder; keep installation files outside it`,
      );
  }
}

/** A failure the owner can fix; `fix` is one exact instruction. */
export class InstallerError extends Error {
  constructor(message, fix, options) {
    super(message, options);
    this.name = "InstallerError";
    this.fix = fix;
  }
}
