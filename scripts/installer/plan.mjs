// Turns the owner's answers into a complete, self-contained plan without changing
// anything. `apply` executes exactly this plan; it never re-reads the answers.
import { existsSync } from "node:fs";
import path from "node:path";
import { detectExisting, detectPrerequisites, tailscaleStatus } from "./detect.mjs";
import { DEFAULT_PORTS, choosePorts, servePortsInUse } from "./ports.mjs";
import { InstallerError, assertProjectsFolderSeparate } from "./primitives.mjs";
import { isInsideFolder } from "../lib/projects-folder.mjs";

export const PLAN_VERSION = 1;
export const DEFAULT_NAME = "Vorteo";
const DEFAULT_SUBNET_OCTET = 250;
// docker/multiplex/common.sh accepts only these characters in a bind-mounted folder.
const COMPOSE_SAFE_PATH = /^\/[A-Za-z0-9._/@+-]+$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function expandHome(value, home) {
  if (value === "~") return home;
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

function requireAbsolute(value, label, home) {
  if (typeof value !== "string" || !value.trim())
    throw new InstallerError(`${label} is missing.`, `Answer the ${label} question.`);
  const expanded = expandHome(value.trim(), home);
  if (!path.isAbsolute(expanded))
    throw new InstallerError(
      `${label} must be an absolute path: ${value}`,
      `Use a path such as ${home}/dev.`,
    );
  return path.resolve(expanded);
}

function validateName(input) {
  const name = typeof input === "string" && input.trim() ? input.trim() : DEFAULT_NAME;
  if (name.length > 40 || /\p{Cc}/u.test(name))
    throw new InstallerError(
      "The installation name must be 1 to 40 characters.",
      "Choose a shorter name.",
    );
  return name;
}

function validateRemote(input, home) {
  const mode = input?.mode;
  if (mode !== "tailscale" && mode !== "local")
    throw new InstallerError(
      'remote.mode must be "tailscale" or "local".',
      "Answer the remote access question.",
    );
  if (input.authKeyFile === undefined) return { mode };
  if (mode !== "tailscale")
    throw new InstallerError(
      "An auth key only applies to Tailscale.",
      "Remove remote.authKeyFile.",
    );
  const authKeyFile = requireAbsolute(input.authKeyFile, "Tailscale auth key file", home);
  if (!existsSync(authKeyFile))
    throw new InstallerError(
      `The auth key file ${authKeyFile} does not exist.`,
      "Save the auth key to that file first.",
    );
  return { mode, authKeyFile };
}

function validateSource(input, home) {
  const sourceDirectory = requireAbsolute(input, "Source folder", home);
  if (!existsSync(path.join(sourceDirectory, ".git")))
    throw new InstallerError(
      `${sourceDirectory} is not a Git checkout of Vorteo.`,
      "Fetch the release into that folder with git, then plan again.",
    );
  return sourceDirectory;
}

/** Normalizes the answers file. Every error names the answer to change. */
export function validateAnswers(input, { home }) {
  if (!input || typeof input !== "object")
    throw new InstallerError(
      "The answers file must hold a JSON object.",
      "Rewrite the answers file.",
    );
  if (typeof input.devContainer !== "boolean")
    throw new InstallerError(
      "devContainer must be true or false.",
      "Answer the Dev container question.",
    );
  if (
    input.version !== undefined &&
    (typeof input.version !== "string" || !VERSION.test(input.version))
  )
    throw new InstallerError(
      `The version ${input.version} is not a tag or commit.`,
      "Use a release tag such as v1.2.3.",
    );
  const projectsFolder = requireAbsolute(input.projectsFolder ?? "~/dev", "Projects folder", home);
  if (input.devContainer && !COMPOSE_SAFE_PATH.test(projectsFolder))
    throw new InstallerError(
      `The Dev container cannot mount ${projectsFolder}.`,
      "Choose a Projects folder whose path has only letters, digits and ._@+- characters.",
    );
  return {
    devContainer: input.devContainer,
    name: validateName(input.name),
    projectsFolder,
    remote: validateRemote(input.remote, home),
    sourceDirectory: validateSource(input.sourceDirectory, home),
    ...(input.version ? { version: input.version } : {}),
  };
}

function ipv4(value) {
  return value.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
}

/** True when two IPv4 CIDR blocks share any address. */
export function subnetsOverlap(a, b) {
  const [aAddress, aBits] = a.split("/");
  const [bAddress, bBits] = b.split("/");
  const bits = Math.min(Number(aBits), Number(bBits));
  const size = 2 ** (32 - bits);
  return Math.floor(ipv4(aAddress) / size) === Math.floor(ipv4(bAddress) / size);
}

/** The first private /24 inside 172.16.0.0/12 that no Docker network uses, from 172.31.250.0. */
export function chooseSubnet(used) {
  const v4 = used.filter((subnet) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet));
  for (let second = 31; second >= 16; second -= 1) {
    const thirds = Array.from({ length: 256 }, (_, index) => index);
    if (second === 31)
      thirds.sort(
        (x, y) => (x >= DEFAULT_SUBNET_OCTET ? 0 : 1) - (y >= DEFAULT_SUBNET_OCTET ? 0 : 1),
      );
    for (const third of thirds) {
      const subnet = `172.${second}.${third}.0/24`;
      if (!v4.some((other) => subnetsOverlap(subnet, other))) return subnet;
    }
  }
  throw new InstallerError(
    "Every 172.16.0.0/12 subnet is in use by Docker.",
    "Remove unused Docker networks with `docker network prune`.",
  );
}

async function dockerNetworks(context, docker) {
  const ids = (await context.run(docker, ["network", "ls", "-q"])).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  return JSON.parse(await context.run(docker, ["network", "inspect", ...ids]));
}

function dockerSubnets(networks) {
  return networks.flatMap((network) =>
    (network.IPAM?.Config ?? []).map((entry) => entry.Subnet).filter(Boolean),
  );
}

/** The default bridge's gateway: what host.docker.internal (host-gateway) names on Linux. */
function bridgeAddress(networks) {
  const bridge = networks.find((network) => network.Name === "bridge");
  const gateway = bridge?.IPAM?.Config?.find((entry) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(entry.Gateway ?? ""),
  )?.Gateway;
  return gateway ?? "172.17.0.1";
}

async function resolveRevision(context, git, answers) {
  try {
    return await context.run(
      git,
      ["rev-parse", "--verify", `${answers.version ?? "HEAD"}^{commit}`],
      {
        cwd: answers.sourceDirectory,
      },
    );
  } catch (error) {
    throw new InstallerError(
      `The source folder has no commit for ${answers.version ?? "HEAD"}.`,
      "Fetch the release tags into the source folder, then plan again.",
      { cause: error },
    );
  }
}

function assertPrerequisites(prerequisites, answers) {
  const failures = [];
  if (!prerequisites.node.ok)
    failures.push(["Node 24 or later is required.", prerequisites.node.fix]);
  if (!prerequisites.git.ok) failures.push(["Git is required.", prerequisites.git.fix]);
  if (answers.devContainer && !prerequisites.docker.running)
    failures.push(["The Dev container needs Docker running.", prerequisites.docker.fix]);
  if (answers.remote.mode === "tailscale") {
    const { tailscale } = prerequisites;
    if (!tailscale.ok || !tailscale.running || (!tailscale.loggedIn && !answers.remote.authKeyFile))
      failures.push(["Remote access needs Tailscale running and signed in.", tailscale.fix]);
  }
  if (failures.length)
    throw new InstallerError(
      failures.map(([message]) => message).join(" "),
      failures.map(([, fix]) => fix).join(" "),
    );
}

/** Which legacy deployment, if any, this plan adopts instead of creating Dev. */
function adoptedDeployment(existing, answers) {
  if (!answers.devContainer) return undefined;
  if (existing.kind === "legacy-container") return existing.deployment;
  if (existing.kind === "legacy-lab" && existing.adoptable) return existing.deployment;
  return undefined;
}

export function planSteps({ devContainer, adopt, remote }) {
  return [
    "prepare",
    "identity",
    ...(remote === "tailscale" ? ["tailscale"] : []),
    ...(devContainer ? ["dev-images", adopt ? "dev-adopt" : "dev-create", "dev-identity"] : []),
    "release",
    "host-config",
    ...(devContainer ? ["dev-pair"] : []),
    "services",
    "ready",
    ...(remote === "tailscale" ? ["remote"] : []),
    ...(devContainer ? ["guest-client"] : []),
    "finish",
  ];
}

function npmPath(context) {
  const beside = path.join(path.dirname(context.execPath), "npm");
  return existsSync(beside) ? beside : (context.which("npm") ?? "npm");
}

function assertLayout(answers, root, adopt) {
  // Adoption never moves a deployment, so one inside the installation folder cannot stay.
  if (adopt && (isInsideFolder(adopt.path, root) || isInsideFolder(root, adopt.path)))
    throw new InstallerError(
      `The existing Dev deployment in ${adopt.path} overlaps the installation folder ${root}.`,
      `Plan again with --root ${path.join(path.dirname(root), "vorteo-installation")} so both stay where they are.`,
    );
  const protectedPaths = [root, answers.sourceDirectory, ...(adopt ? [adopt.path] : [])];
  try {
    assertProjectsFolderSeparate(answers.projectsFolder, protectedPaths);
  } catch (error) {
    throw new InstallerError(
      error.message,
      "Choose a Projects folder outside the installation folder.",
    );
  }
  if (isInsideFolder(root, answers.projectsFolder))
    throw new InstallerError(
      `The Projects folder ${answers.projectsFolder} is inside the installation folder ${root}.`,
      "Choose a Projects folder outside the installation folder, such as ~/dev.",
    );
}

/** The tailnet name and the HTTPS ports its serve routes already own. */
async function tailnetState(context, answers, prerequisites, tailscale) {
  if (answers.remote.mode !== "tailscale" || !prerequisites.tailscale.loggedIn)
    return { hostname: null, servePorts: new Set() };
  const hostname = (await tailscaleStatus(context, tailscale)).hostname ?? null;
  try {
    const serve = JSON.parse(await context.run(tailscale, ["serve", "status", "--json"]));
    return { hostname, servePorts: servePortsInUse(serve, hostname) };
  } catch {
    return { hostname, servePorts: new Set() };
  }
}

function wantedPorts(answers) {
  const tailscale = answers.remote.mode === "tailscale";
  return [
    "coordinator",
    "host",
    ...(answers.devContainer ? ["devRelay"] : []),
    ...(tailscale ? ["https", "hostHttps"] : []),
    ...(tailscale && answers.devContainer ? ["devHttps"] : []),
  ];
}

/** VORTEO_SERVICE_MANAGER=process is for test machines without a service manager. */
function serviceManagerKind(context) {
  if (context.env?.VORTEO_SERVICE_MANAGER === "process") return "process";
  return context.platform === "darwin" ? "launchd" : "systemd-user";
}

function planPaths(context, answers, revision, adopt) {
  const root = context.root;
  const host = path.join(root, "host");
  return {
    home: context.home,
    root,
    source: answers.sourceDirectory,
    host,
    state: path.join(root, "state"),
    journal: path.join(root, "state", "install.json"),
    ownerPassword: path.join(host, "owner-password"),
    record: path.join(host, "installation.json"),
    coordinatorConfig: path.join(host, "coordinator.json"),
    coordinatorState: path.join(host, "state", "coordinator"),
    hostHome: path.join(host, "state", "host"),
    release: path.join(host, "releases", revision),
    // Services and the interface run through these links, so an upgrade repoints them.
    hostReleaseLink: path.join(host, "releases", "host-current"),
    coordinatorReleaseLink: path.join(host, "releases", "coordinator-current"),
    logs: path.join(host, "logs"),
    projectsFolder: answers.projectsFolder,
    ...(answers.devContainer
      ? { container: adopt ? adopt.path : path.join(root, "container") }
      : {}),
  };
}

async function planDev(context, docker, existing, adopt) {
  const networks = await dockerNetworks(context, docker);
  const dev = {
    subnet: chooseSubnet(dockerSubnets(networks)),
    bridgeAddress: bridgeAddress(networks),
    user: "paseo",
    cli: "paseo",
    daemonHome: "/home/paseo/.paseo",
  };
  if (!adopt) return dev;
  return {
    ...dev,
    instance: adopt.instance,
    legacy: {
      kind: existing.kind,
      path: adopt.path,
      gateMode: adopt.gateMode,
      ...(adopt.projectsFolder ? { projectsFolder: adopt.projectsFolder } : {}),
    },
  };
}

/** Deployments this plan leaves alone, named in the summary. */
function untouchedPaths(existing, adopt) {
  if (adopt) return [];
  if (existing.kind === "legacy-lab") return [existing.paths.lab];
  if (existing.kind === "legacy-container") return existing.candidates;
  return [];
}

function assertNoCurrent(existing, root) {
  if (existing.kind !== "current") return;
  throw new InstallerError(
    `A Vorteo installation already exists in ${root}.`,
    existing.origin
      ? `Open ${existing.origin}, or run \`node scripts/installer/main.mjs repair\`.`
      : "Run `node scripts/installer/main.mjs apply` with its plan to finish it, or `repair`.",
  );
}

/**
 * @returns {Promise<{ plan: object, summary: string[] }>}
 */
export async function createPlan(rawAnswers, context) {
  if (!["darwin", "linux"].includes(context.platform))
    throw new InstallerError(
      `Vorteo installs on macOS and Linux, not ${context.platform}.`,
      "Run the installer on a Mac or a Linux machine.",
    );
  const answers = validateAnswers(rawAnswers, context);
  const existing = await detectExisting(context, { docker: answers.devContainer });
  assertNoCurrent(existing, context.root);
  const adopt = adoptedDeployment(existing, answers);
  assertLayout(answers, context.root, adopt);
  const prerequisites = await detectPrerequisites(context, { docker: answers.devContainer });
  assertPrerequisites(prerequisites, answers);

  const tailscale = answers.remote.mode === "tailscale";
  const executables = {
    node: context.execPath,
    git: context.which("git"),
    npm: npmPath(context),
    ...(answers.devContainer ? { docker: context.which("docker") } : {}),
    ...(tailscale ? { tailscale: context.which("tailscale") } : {}),
  };
  const revision = await resolveRevision(context, executables.git, answers);
  const { hostname, servePorts } = await tailnetState(
    context,
    answers,
    prerequisites,
    executables.tailscale,
  );
  // An adopted deployment already owns its published port; the gate relay takes it over.
  const fixed = adopt?.loopbackPort ? { devRelay: adopt.loopbackPort } : {};
  const ports = await choosePorts({
    wanted: wantedPorts(answers),
    isPortFree: context.isPortFree,
    servePorts,
    fixed,
  });
  const installationId = context.randomId();
  const label = `local.vorteo.${installationId}`;
  const untouched = untouchedPaths(existing, adopt);
  const plan = {
    version: PLAN_VERSION,
    installationId,
    createdAt: context.now().toISOString(),
    platform: context.platform,
    kind: adopt ? "adopt" : "new",
    name: answers.name,
    revision,
    ...(answers.version ? { releaseVersion: answers.version } : {}),
    devContainer: answers.devContainer,
    remote: { ...answers.remote, ...(hostname ? { hostname } : {}) },
    ports,
    paths: planPaths(context, answers, revision, adopt),
    services: {
      manager: serviceManagerKind(context),
      host: `${label}.host`,
      coordinator: `${label}.installation`,
    },
    executables,
    ...(answers.devContainer
      ? { dev: await planDev(context, executables.docker, existing, adopt) }
      : {}),
    ...(untouched.length ? { untouched } : {}),
    steps: planSteps({
      devContainer: answers.devContainer,
      adopt: Boolean(adopt),
      remote: answers.remote.mode,
    }),
  };
  return { plan, summary: summarizePlan(plan) };
}

function movedPorts(ports) {
  return Object.entries(ports)
    .filter(([key, port]) => port !== DEFAULT_PORTS[key])
    .map(([key, port]) => `${key} ${port} (default ${DEFAULT_PORTS[key]} is in use)`);
}

export function publicOrigin(plan, hostname = plan.remote.hostname) {
  if (plan.remote.mode !== "tailscale") return `http://localhost:${plan.ports.coordinator}`;
  return hostname ? `https://${hostname}:${plan.ports.https}` : null;
}

export function summarizePlan(plan) {
  const lines = [];
  lines.push(
    plan.kind === "adopt"
      ? `Wrap the existing Dev deployment at ${plan.paths.container} into a new installation named "${plan.name}". Its identity, home, workspace and files stay where they are.`
      : `Create a new installation named "${plan.name}" in ${plan.paths.root}.`,
  );
  lines.push(
    `Source: ${plan.paths.source} at ${plan.revision.slice(0, 12)}${plan.releaseVersion ? ` (${plan.releaseVersion})` : ""}.`,
  );
  lines.push(`Projects folder: ${plan.paths.projectsFolder}, created if missing.`);
  if (plan.devContainer) {
    lines.push(
      plan.kind === "adopt"
        ? `Dev moves to gate mode with automatic rollback; its network then goes only through the gate on ${plan.dev.subnet}.`
        : `Dev container in ${plan.paths.container}, behind the network gate on ${plan.dev.subnet}.`,
    );
    if (
      plan.dev.legacy?.projectsFolder &&
      plan.dev.legacy.projectsFolder !== plan.paths.projectsFolder
    )
      lines.push(
        `Dev mounted ${plan.dev.legacy.projectsFolder} before; it will mount ${plan.paths.projectsFolder} instead. Nothing is moved.`,
      );
  } else {
    lines.push("No Dev container. Docker is not used.");
  }
  const manager = plan.services.manager === "launchd" ? "launchd agents" : "systemd user services";
  lines.push(
    `Host daemon and coordinator run as ${manager} ${plan.services.host} and ${plan.services.coordinator}.`,
  );
  const local = `http://localhost:${plan.ports.coordinator}`;
  if (plan.remote.mode === "tailscale") {
    const remote =
      publicOrigin(plan) ?? `https://<this machine's tailnet name>:${plan.ports.https}`;
    lines.push(`Interface: ${remote} over Tailscale, and ${local} on this machine.`);
    if (plan.remote.authKeyFile)
      lines.push(`Tailscale signs in first with the auth key in ${plan.remote.authKeyFile}.`);
  } else {
    lines.push(`Interface: ${local} on this machine only. No Tailscale routes are added.`);
  }
  const moved = movedPorts(plan.ports);
  if (moved.length) lines.push(`Ports moved: ${moved.join(", ")}.`);
  lines.push(`Owner password: ${plan.paths.ownerPassword}.`);
  for (const other of plan.untouched ?? []) lines.push(`Left untouched: ${other}.`);
  return lines;
}
