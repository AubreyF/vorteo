// Read-only detection: existing installations, legacy deployments and prerequisites.
// Nothing here writes files or changes services.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const LAB_DIRECTORY = path.join(".local", "share", "vorteo-lab");
export const JOURNAL = path.join("state", "install.json");
const MINIMUM_NODE = 24;

export function readEnvFile(file) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A standalone docker/multiplex deployment: its marker and an .env holding its instance
 * name and password. Returns what adoption needs, never the password itself.
 */
export function inspectDeployment(directory) {
  const envFile = path.join(directory, ".env");
  if (!existsSync(path.join(directory, ".container-installation")) || !existsSync(envFile))
    return null;
  let env;
  try {
    env = readEnvFile(envFile);
  } catch {
    return null;
  }
  if (!env.PASEO_INSTANCE || !env.PASEO_PASSWORD) return null;
  const loopback = readJson(path.join(directory, "host-loopback.compose.json"));
  const published = loopback?.services?.paseo?.ports?.[0]?.published;
  const projects = readJson(path.join(directory, "projects-folder.compose.json"));
  return {
    path: directory,
    instance: env.PASEO_INSTANCE,
    gateMode: existsSync(path.join(directory, ".gate-mode")),
    loopbackPort: published === undefined ? undefined : Number(published),
    projectsFolder:
      projects?.services?.paseo?.environment?.PASEO_PROJECTS_ROOT ?? env.PASEO_PROJECTS_FOLDER,
  };
}

function childDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

/** Working directories of Compose projects that run a `paseo` service, running or not. */
async function composeDirectories(context) {
  const docker = context.which("docker");
  if (!docker) return [];
  try {
    const output = await context.run(docker, [
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.service=paseo",
      "--format",
      '{{.Label "com.docker.compose.project.working_dir"}}',
    ]);
    return output.split("\n").filter((line) => line.startsWith("/"));
  } catch {
    return [];
  }
}

/**
 * Legacy deployments live in the installation folder, beside a `~/vorteo-source`
 * checkout (any folder directly in the home folder), in the lab layout, or wherever a
 * Compose project with a `paseo` service was started.
 */
export async function findLegacyDeployments(context, { exclude = [], docker = true } = {}) {
  const candidates = [
    context.root,
    path.join(context.root, "container"),
    ...childDirectories(context.home),
    ...(docker ? await composeDirectories(context) : []),
  ];
  const seen = new Set(exclude.map((file) => path.resolve(file)));
  const found = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const deployment = inspectDeployment(resolved);
    if (deployment) found.push(deployment);
  }
  return found;
}

function inspectLab(home) {
  const lab = path.join(home, LAB_DIRECTORY);
  const host = path.join(lab, "host", "installation.json");
  const container = inspectDeployment(path.join(lab, "container"));
  if (!existsSync(host) && !container) return null;
  return {
    path: lab,
    host: existsSync(host) ? path.dirname(host) : undefined,
    container: container ?? undefined,
  };
}

function currentInstallation(root) {
  const journal = readJson(path.join(root, JOURNAL));
  const record = path.join(root, "host", "installation.json");
  if (!journal && !existsSync(record)) return null;
  return {
    kind: "current",
    state: journal && !journal.completedAt ? "installing" : "installed",
    paths: {
      root,
      journal: path.join(root, JOURNAL),
      host: path.join(root, "host"),
      ...(journal?.plan?.paths?.container ? { container: journal.plan.paths.container } : {}),
    },
    origin: journal?.outputs?.origin ?? readJson(record)?.origin,
  };
}

function labResult(lab) {
  return {
    kind: "legacy-lab",
    paths: {
      lab: lab.path,
      ...(lab.host ? { host: lab.host } : {}),
      ...(lab.container ? { container: lab.container.path } : {}),
    },
    // A lab with its own Host is a separate installation; only a container-only lab
    // is adopted. The new installation then lives beside it with its own ports.
    adoptable: !lab.host && Boolean(lab.container),
    ...(lab.container ? { deployment: lab.container } : {}),
  };
}

/**
 * What already exists on this machine, most authoritative first. `docker: false` skips
 * the Compose project query, for Host-only plans that make no Docker calls.
 */
export async function detectExisting(context, { docker = true } = {}) {
  const current = currentInstallation(context.root);
  if (current) return current;
  const lab = inspectLab(context.home);
  const deployments = await findLegacyDeployments(context, {
    exclude: lab ? [path.join(lab.path, "container")] : [],
    docker,
  });
  if (deployments.length) {
    return {
      kind: "legacy-container",
      paths: {
        container: deployments[0].path,
        // The installer offers the deployment's own Projects folder as the default.
        ...(deployments[0].projectsFolder ? { projectsFolder: deployments[0].projectsFolder } : {}),
      },
      deployment: deployments[0],
      candidates: deployments.map((deployment) => deployment.path),
      ...(lab ? { lab: lab.path } : {}),
    };
  }
  return lab ? labResult(lab) : { kind: "none", paths: {} };
}

const FIXES = {
  darwin: {
    node: "Install Node 24: `brew install node@24`, or `nvm install 24` with nvm.",
    git: "Install Git: `xcode-select --install`.",
    docker: "Install Docker Desktop from https://www.docker.com/products/docker-desktop/.",
    dockerRunning: "Open Docker Desktop and wait until it says it is running.",
    tailscale: "Install Tailscale from https://tailscale.com/download/mac.",
    tailscaleRunning: "Open the Tailscale app from Applications.",
    tailscaleLogin: "Open the Tailscale app and sign in, or rerun with an auth key.",
  },
  linux: {
    node: "Install Node 24: `nvm install 24` with nvm, or your distribution's nodejs 24 package.",
    git: "Install Git with your package manager, such as `sudo apt install git`.",
    docker: "Install Docker Engine: https://docs.docker.com/engine/install/.",
    dockerRunning:
      "Start Docker with `sudo systemctl start docker` and add yourself to the docker group.",
    tailscale: "Install Tailscale: `curl -fsSL https://tailscale.com/install.sh | sh`.",
    tailscaleRunning: "Start Tailscale with `sudo systemctl enable --now tailscaled`.",
    tailscaleLogin: "Run `sudo tailscale up` and sign in, or rerun with an auth key.",
  },
};

async function commandVersion(context, executable, args) {
  try {
    return (await context.run(executable, args)).split("\n")[0];
  } catch {
    return undefined;
  }
}

/** Parses `tailscale status --json`, which exits non-zero when the backend is not running. */
export async function tailscaleStatus(context, tailscale) {
  let output;
  try {
    output = await context.run(tailscale, ["status", "--json"]);
  } catch (error) {
    output = error.stdout;
  }
  try {
    const status = JSON.parse(output);
    return {
      backendState: status.BackendState,
      hostname: status.Self?.DNSName?.replace(/\.$/, "") || undefined,
    };
  } catch {
    return { backendState: undefined, hostname: undefined };
  }
}

async function dockerPrerequisite(context, fixes, check) {
  const executable = check ? context.which("docker") : null;
  if (!executable) return { ok: false, running: false, fix: fixes.docker };
  const version = await commandVersion(context, executable, [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  return version
    ? { ok: true, running: true, version }
    : { ok: true, running: false, fix: fixes.dockerRunning };
}

async function tailscalePrerequisite(context, fixes) {
  const executable = context.which("tailscale");
  if (!executable) return { ok: false, running: false, loggedIn: false, fix: fixes.tailscale };
  const status = await tailscaleStatus(context, executable);
  const running = Boolean(status.backendState) && status.backendState !== "Stopped";
  const loggedIn = status.backendState === "Running";
  let fix;
  if (!running) fix = fixes.tailscaleRunning;
  else if (!loggedIn) fix = fixes.tailscaleLogin;
  return {
    ok: true,
    running,
    loggedIn,
    ...(status.hostname ? { hostname: status.hostname } : {}),
    ...(fix ? { fix } : {}),
  };
}

/** `docker: false` reports Docker as absent without calling it. */
export async function detectPrerequisites(context, { docker = true } = {}) {
  const fixes = FIXES[context.platform] ?? FIXES.linux;
  const major = Number(/^v(\d+)/.exec(context.nodeVersion)?.[1] ?? 0);
  const node = {
    ok: major >= MINIMUM_NODE,
    version: context.nodeVersion,
    ...(major >= MINIMUM_NODE ? {} : { fix: fixes.node }),
  };
  const gitPath = context.which("git");
  const gitVersion = gitPath ? await commandVersion(context, gitPath, ["--version"]) : undefined;
  const git = {
    ok: Boolean(gitVersion),
    ...(gitVersion ? { version: gitVersion } : { fix: fixes.git }),
  };
  return {
    node,
    git,
    docker: await dockerPrerequisite(context, fixes, docker),
    tailscale: await tailscalePrerequisite(context, fixes),
  };
}

export async function detect(context) {
  const platform = context.platform === "darwin" ? "darwin" : "linux";
  return {
    platform,
    supported: ["darwin", "linux"].includes(context.platform),
    existing: await detectExisting(context),
    prerequisites: await detectPrerequisites(context),
  };
}
