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
    // In gate mode the gate relay publishes Dev on this Host loopback port.
    ...(env.PASEO_GATE_RELAY_PORT ? { relayPort: Number(env.PASEO_GATE_RELAY_PORT) } : {}),
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
export async function findLegacyDeployments(
  context,
  { exclude = [], docker = true, extra = [] } = {},
) {
  const candidates = [
    context.root,
    path.join(context.root, "container"),
    ...extra,
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

function xmlText(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Words of a systemd ExecStart= value, undoing the quoting systemdQuote applies. */
function systemdWords(value) {
  const words = [];
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const word = match[1] === undefined ? match[2] : match[1].replace(/\\(.)/g, "$1");
    words.push(word.replaceAll("%%", "%").replaceAll("$$", "$"));
  }
  return words;
}

/** The program arguments a launchd plist or a systemd unit starts. */
export function serviceArguments(text) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (array) return [...array[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlText(m[1]));
  const exec = /^ExecStart=(.*)$/m.exec(text);
  return exec ? systemdWords(exec[1]) : [];
}

const SERVICE_FILES = [
  { manager: "launchd", directory: ["Library", "LaunchAgents"], suffix: ".installation.plist" },
  {
    manager: "systemd-user",
    directory: [".config", "systemd", "user"],
    suffix: ".installation.service",
  },
];

/** Installation roots named by local.vorteo.*.installation services: their config's folder. */
export function serviceRoots(home) {
  const roots = [];
  for (const { directory, suffix } of SERVICE_FILES) {
    const folder = path.join(home, ...directory);
    let names = [];
    try {
      names = readdirSync(folder).filter(
        (name) => name.startsWith("local.vorteo.") && name.endsWith(suffix),
      );
    } catch {
      continue;
    }
    for (const name of names.toSorted()) {
      let argv = [];
      try {
        argv = serviceArguments(readFileSync(path.join(folder, name), "utf8"));
      } catch {
        continue;
      }
      const configFile = argv.findLast((arg) => arg.endsWith(".json"));
      if (configFile && path.isAbsolute(configFile)) roots.push(path.dirname(configFile));
    }
  }
  return roots;
}

/**
 * What a folder holding installation.json and its coordinator configuration is: an
 * installer-made installation (`current`, with its root), an old Host root
 * (`legacy-host`), or nothing. Reads only; secrets never leave this function.
 */
export function inspectHostRoot(root) {
  const record = readJson(path.join(root, "installation.json"));
  if (!record || typeof record !== "object") return null;
  const configFile = record.configFile ?? path.join(root, "coordinator.json");
  const config = readJson(configFile);
  if (!config?.public?.installationId) return null;
  if (config.deployment?.installRoot)
    return { kind: "current", root: config.deployment.installRoot };
  if (existsSync(path.join(root, JOURNAL))) return { kind: "current", root };
  return {
    kind: "legacy-host",
    root,
    configFile,
    installationId: config.public.installationId,
    origin: config.public.origin,
    container: Boolean(config.container),
    sourceUpdates: Boolean(config.sourceUpdates),
  };
}

/**
 * Old Host roots, most specific first: the --root folder, the earlier lab layout, then
 * any root a local.vorteo.*.installation launchd agent or systemd unit runs.
 */
export function findHostRoots(context) {
  const candidates = [
    context.root,
    path.join(context.home, LAB_DIRECTORY, "host"),
    ...serviceRoots(context.home),
  ];
  const seen = new Set();
  const found = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const host = inspectHostRoot(resolved);
    if (host) found.push(host);
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

/** An in-place upgrade that stopped part way is still offered as one, so a rerun resumes it. */
function stoppedAdoption(root, journal) {
  return {
    kind: "legacy-host",
    resume: true,
    paths: { root, host: root, coordinatorConfig: journal.plan.paths.coordinatorConfig },
    installationId: journal.installationId,
    origin: journal.plan.origin,
    container: journal.plan.devContainer,
    candidates: [root],
  };
}

function currentInstallation(root) {
  const journal = readJson(path.join(root, JOURNAL));
  const record = path.join(root, "host", "installation.json");
  if (!journal && !existsSync(record)) return null;
  const paths = journal?.plan?.paths ?? {};
  if (journal?.plan?.kind === "adopt-host" && !journal.completedAt)
    return stoppedAdoption(root, journal);
  return {
    kind: "current",
    state: journal && !journal.completedAt ? "installing" : "installed",
    paths: {
      root,
      journal: path.join(root, JOURNAL),
      // A Host root upgraded in place is its own `host` folder.
      host: paths.host ?? path.join(root, "host"),
      ...(paths.container ? { container: paths.container } : {}),
    },
    origin: journal?.outputs?.origin ?? readJson(record)?.origin,
  };
}

function legacyHostResult(host, others) {
  return {
    kind: "legacy-host",
    paths: { root: host.root, host: host.root, coordinatorConfig: host.configFile },
    installationId: host.installationId,
    origin: host.origin,
    container: host.container,
    sourceUpdates: host.sourceUpdates,
    candidates: [host.root, ...others.map((other) => other.root)],
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
  // An old Host installation wins over its own Dev deployment, which would otherwise be
  // found below as a legacy container and wrapped into a second installation.
  const [host, ...others] = findHostRoots(context);
  if (host?.kind === "current") {
    const found = currentInstallation(host.root);
    if (found) return found;
  } else if (host) return legacyHostResult(host, others);
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
