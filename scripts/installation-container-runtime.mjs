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
    result = { release, previous, sourceCommit: input.update.sourceCommit };
  } catch (error) {
    throw new Error(`Dev build failed before activation. Inspect ${path.join(work, "build.log")}`, {
      cause: error,
    });
  } finally {
    fs.closeSync(log);
  }
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
