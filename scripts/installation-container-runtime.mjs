// This fixed helper runs as the configured Dev user, never as container root.
// The protected coordinator supplies its source and arguments, not the uploaded bundle.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const input = JSON.parse(process.argv[1]);
const { settings, action } = input;
const root = fs.realpathSync(settings.releaseRoot);
const link = settings.currentReleaseLink;
if (!path.isAbsolute(link) || path.dirname(link) !== root)
  throw new Error("The managed release link must be directly inside the release root");
const selected = () => fs.realpathSync(link);
const receipt = (release) =>
  JSON.parse(fs.readFileSync(path.join(release, ".installation-source.json"), "utf8"));
function withinRoot(release) {
  const resolved = fs.realpathSync(release);
  if (!resolved.startsWith(root + path.sep)) throw new Error("Release escaped the configured root");
  return resolved;
}
function supervisor() {
  const marker = JSON.parse(
    fs.readFileSync(path.join(settings.home, "managed-supervisor.json"), "utf8"),
  );
  if (
    marker.version !== 1 ||
    marker.link !== link ||
    marker.root !== root ||
    !Number.isSafeInteger(marker.pid) ||
    marker.pid <= 0
  )
    throw new Error("Bootstrap the managed Dev supervisor before enabling source updates");
  const environment = fs.readFileSync(`/proc/${marker.pid}/environ`, "utf8").split("\0");
  if (
    !environment.includes(`PASEO_MANAGED_RELEASE_LINK=${link}`) ||
    !environment.includes(`PASEO_MANAGED_RELEASE_ROOT=${settings.releaseRoot}`)
  )
    throw new Error("The running supervisor does not own the configured release selection");
  return marker;
}
function select(release, expected) {
  if (selected() !== expected)
    throw new Error("Release selection changed; no activation performed");
  const temporary = `${link}.${randomUUID()}.next`;
  fs.symlinkSync(withinRoot(release), temporary);
  fs.renameSync(temporary, link);
}
// This Host-supplied collector binds built bytes, including every dependency.
// It never imports code from the candidate while deciding its integrity.
function artifactDigest(directory) {
  const canonical = fs.realpathSync(directory);
  if (canonical !== directory) throw new Error("Candidate requires a canonical directory");
  const digest = createHash("sha256").update("vorteo-container-artifact-v1\n");
  const deadline = Date.now() + 120_000;
  const buffer = Buffer.alloc(64 * 1024);
  const observed = new Map();
  const links = new Map();
  let entries = 0;
  let bytes = 0;
  const budget = () => {
    if (Date.now() >= deadline || entries > 250_000 || bytes > 8 * 1024 ** 3)
      throw new Error("Candidate verification exceeded its bounds");
  };
  const identity = (stat) =>
    [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.uid,
      stat.gid,
      stat.nlink,
      stat.size,
      stat.ctimeNs,
      stat.mtimeNs,
    ].join(":");
  const visit = (relative) => {
    entries++;
    budget();
    const file = path.join(directory, relative);
    const stat = fs.lstatSync(file, { bigint: true });
    if (
      stat.uid !== BigInt(process.getuid()) ||
      (!stat.isSymbolicLink() && (stat.mode & 0o022n) !== 0n)
    )
      throw new Error("Candidate has unprotected ownership or permissions");
    observed.set(file, identity(stat));
    if (stat.isDirectory()) {
      digest.update(JSON.stringify(["directory", relative, String(stat.mode)]) + "\n");
      for (const entry of fs.readdirSync(file).sort()) visit(path.join(relative, entry));
    } else if (stat.isFile()) {
      bytes += Number(stat.size);
      budget();
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      const content = createHash("sha256");
      try {
        if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(stat))
          throw new Error("Candidate changed");
        for (;;) {
          budget();
          const count = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          content.update(buffer.subarray(0, count));
        }
        if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(stat))
          throw new Error("Candidate changed");
      } finally {
        fs.closeSync(fd);
      }
      if (stat.nlink > 1n) {
        const key = `${stat.dev}:${stat.ino}`;
        const group = links.get(key) ?? { count: stat.nlink, paths: [] };
        group.paths.push(relative);
        links.set(key, group);
      }
      digest.update(
        JSON.stringify(["file", relative, String(stat.mode), content.digest("hex")]) + "\n",
      );
    } else if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(file);
      if (!resolved.startsWith(directory + path.sep) && resolved !== directory)
        throw new Error("Candidate link escapes release");
      digest.update(JSON.stringify(["link", relative, fs.readlinkSync(file)]) + "\n");
    } else throw new Error("Candidate contains a non-runtime file");
  };
  visit("");
  for (const group of links.values()) {
    if (BigInt(group.paths.length) !== group.count)
      throw new Error("Candidate hard link escapes release");
    digest.update(JSON.stringify(["hard-links", group.paths.sort()]) + "\n");
  }
  for (const [file, expected] of observed) {
    budget();
    if (identity(fs.lstatSync(file, { bigint: true })) !== expected)
      throw new Error("Candidate changed during verification");
  }
  return digest.digest("hex");
}

const workerEntry = (release) =>
  path.join(release, "packages/server/dist/server/server/daemon-worker.js");
const previous = withinRoot(selected());
let result;
if (action === "inspect") {
  supervisor();
  result = { release: previous, ...receipt(previous) };
} else if (action === "prepare") {
  supervisor();
  if (previous !== input.previous || receipt(previous).sourceCommit !== input.update.baseCommit)
    throw new Error("Installed Dev source changed before build");
  if (!/^[a-f0-9-]{36}$/.test(input.jobId)) throw new Error("Invalid job identity");
  const work = path.join(root, input.jobId);
  fs.mkdirSync(work, { mode: 0o700 });
  const archive = path.join(work, "source.tar");
  const bytes = fs.readFileSync(0);
  if (
    bytes.length > 512 * 1024 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !== input.archiveSha256
  )
    throw new Error("Approved source archive changed");
  fs.writeFileSync(archive, bytes, { mode: 0o600, flag: "wx" });
  const release = path.join(work, "release");
  fs.mkdirSync(release, { mode: 0o700 });
  const log = fs.openSync(path.join(work, "build.log"), "wx", 0o600);
  const env = {
    ...process.env,
    PATH: `${path.dirname(settings.node)}:${process.env.PATH}`,
    LEFTHOOK: "0",
    PASEO_BUILD_COMMIT: input.update.sourceCommit,
  };
  // A candidate validates itself; it must not resolve the currently selected worker.
  delete env.PASEO_MANAGED_RELEASE_LINK;
  delete env.PASEO_MANAGED_RELEASE_ROOT;
  const run = (command, args, extraEnv = {}) =>
    execFileSync(command, args, {
      cwd: release,
      env: { ...env, ...extraEnv },
      timeout: 45 * 60_000,
      stdio: ["ignore", log, log],
    });
  try {
    run("tar", ["--no-same-owner", "-xf", archive]);
    run("npm", ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"]);
    run("npm", ["rebuild", "--foreground-scripts"]);
    run("npm", ["run", "postinstall"]);
    run("npm", ["run", "build:server"]);
    run(
      settings.node,
      [path.join(release, "packages/server/dist/scripts/supervisor-entrypoint.js")],
      { PASEO_HOME: settings.home, PASEO_VALIDATE_STARTUP: "1" },
    );
    if (!fs.statSync(workerEntry(release)).isFile()) throw new Error("Candidate worker missing");
    fs.writeFileSync(
      path.join(release, ".installation-source.json"),
      JSON.stringify(input.update),
      { mode: 0o600, flag: "wx" },
    );
    result = {
      release,
      previous,
      sourceCommit: input.update.sourceCommit,
      artifactSha256: artifactDigest(release),
    };
  } catch (error) {
    throw new Error(`Dev build failed before activation. Inspect ${path.join(work, "build.log")}`, {
      cause: error,
    });
  } finally {
    fs.closeSync(log);
  }
} else if (action === "verify-candidate") {
  supervisor();
  const candidate = withinRoot(input.release);
  if (
    previous !== input.previous ||
    receipt(previous).sourceCommit !== input.update.baseCommit ||
    receipt(candidate).sourceCommit !== input.update.sourceCommit ||
    receipt(candidate).sha256 !== input.update.sha256
  )
    throw new Error("Candidate source or selection differs from approval");
  const artifactSha256 = artifactDigest(candidate);
  if (artifactSha256 !== input.artifactSha256)
    throw new Error("Prepared Dev candidate content changed");
  result = { release: candidate, sourceCommit: input.update.sourceCommit, artifactSha256 };
} else if (action === "activate") {
  supervisor();
  const candidate = withinRoot(input.release);
  if (
    receipt(candidate).sourceCommit !== input.update.sourceCommit ||
    receipt(candidate).sha256 !== input.update.sha256
  )
    throw new Error("Prepared Dev source differs from approval");
  if (receipt(previous).sourceCommit !== input.update.baseCommit)
    throw new Error("Installed Dev source changed");
  if (input.artifactSha256 && artifactDigest(candidate) !== input.artifactSha256)
    throw new Error("Prepared Dev candidate content changed");
  select(candidate, input.previous);
  result = { release: candidate };
} else if (action === "restore") {
  select(input.previous, input.release);
  result = { release: selected() };
} else if (action === "verify") {
  const marker = supervisor();
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error("Invalid daemon PID");
  const command = fs.readFileSync(`/proc/${input.pid}/cmdline`, "utf8").split("\0");
  const status = fs.readFileSync(`/proc/${input.pid}/status`, "utf8");
  const parent = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
  if (
    previous !== input.release ||
    receipt(previous).sourceCommit !== input.update.sourceCommit ||
    fs.realpathSync(`/proc/${input.pid}/exe`) !== fs.realpathSync(settings.node) ||
    !command.includes(workerEntry(previous)) ||
    parent !== marker.pid
  )
    throw new Error("Ready Dev daemon is not running the approved release");
  result = { release: previous, sourceCommit: input.update.sourceCommit, pid: input.pid };
} else throw new Error("Unknown managed release operation");
process.stdout.write(JSON.stringify(result));
