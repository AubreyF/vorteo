// One function per plan step. Each is safe to rerun after a failure: it either finds
// its work already done or redoes only files this installation owns.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { writeProjectsFolderSettings } from "../lib/projects-folder.mjs";
import { writeSystemSource } from "../lib/system-source.mjs";
import {
  buildCoordinatorConfig,
  describeServices,
  devPublicHostname,
  gateRoutes,
  hostClientFile,
  interfaceOrigins,
  devClientOrigin,
} from "./coordinator-config.mjs";
import { readEnvFile, tailscaleStatus } from "./detect.mjs";
import {
  INSTALLATION_SKILL,
  AGENT_SCRIPT,
  buildRelease,
  hostDaemonConfig,
  installGuestClient,
  loadServerModules,
  pairContainerOrigin,
  readContainerServerId,
  renderSkill,
  serveRouteTarget,
  waitForInstallation,
} from "./host-installation.mjs";
import { publicOrigin } from "./plan.mjs";
import {
  InstallerError,
  assertProtectedPaths,
  build,
  privateWrite,
  shellQuote,
  writableBindRoots,
  writeJson,
} from "./primitives.mjs";

export const STEP_TITLES = {
  prepare: "Creating the installation folder",
  identity: "Creating the owner password and installation name",
  tailscale: "Checking Tailscale",
  "dev-images": "Building the Dev and gate images",
  "dev-create": "Creating the Dev container behind the gate",
  "dev-adopt": "Moving the existing Dev container behind the gate",
  "dev-identity": "Reading the Dev identity",
  release: "Building the Host release",
  "host-config": "Writing the Host and coordinator configuration",
  "dev-pair": "Pairing Dev with the installation",
  services: "Installing the Host and coordinator services",
  ready: "Waiting for the Host and coordinator",
  remote: "Adding Tailscale HTTPS routes",
  "guest-client": "Giving Dev agents the installation client",
  finish: "Finishing",
};

const DEPLOYMENT_SCRIPTS = ["common.sh", "update.sh", "gate.sh", "connect.sh", "compose.gate.yaml"];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function containerName(s) {
  return `${s.outputs.instance}-paseo-1`;
}

/**
 * Environment for docker/multiplex scripts: the caller's environment without any
 * PASEO_ setting, which Compose would prefer over the deployment's .env, plus `extra`.
 */
function scriptEnvironment(s, extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  const docker = s.plan.executables.docker;
  if (docker) env.PATH = `${path.dirname(docker)}:${env.PATH ?? "/usr/bin:/bin"}`;
  return { ...env, ...extra };
}

function gateEnvironment(s) {
  const { plan, outputs } = s;
  // An adopted Host installation adds its recovery origin and its own interface origin's route.
  const origins = [...interfaceOrigins(plan, outputs.hostname), ...(plan.dev.extraOrigins ?? [])];
  const routes = [...gateRoutes(plan, outputs.hostname), ...(plan.dev.extraRoutes ?? [])];
  return {
    PASEO_NETWORK_MODE: "gate",
    PASEO_GATE_IMAGE: outputs.gateImage,
    PASEO_PUBLIC_HOSTNAME: devPublicHostname(plan, outputs.hostname),
    PASEO_CORS_ORIGINS: [...new Set(origins)].join(","),
    PASEO_PROJECTS_FOLDER: realpathSync(plan.paths.projectsFolder),
    PASEO_GATE_RELAY_PORT: String(plan.ports.devRelay),
    PASEO_GATE_SUBNET: plan.dev.subnet,
    PASEO_GATE_ROUTES: [...new Set(routes)].join(","),
    PASEO_INSTALLATION_PENDING: "1",
  };
}

/** Starts an existing gate deployment through its own common.sh and waits for health. */
async function composeUp(s, deployment) {
  await s.context.run(
    "bash",
    [
      "-c",
      'deployment="$1"; source "$deployment/common.sh"; paseo_compose up -d --pull never paseo gate; paseo_wait',
      "compose-up",
      deployment,
    ],
    { env: scriptEnvironment(s), timeout: 10 * 60_000 },
  );
}

async function serverModules(s) {
  s.context.serverModules ??= await loadServerModules(s.plan.paths.release);
  return s.context.serverModules;
}

function devPassword(s) {
  const password = readEnvFile(path.join(s.plan.paths.container, ".env")).PASEO_PASSWORD;
  if (!password)
    throw new InstallerError(
      "The Dev deployment has no password in its .env.",
      "Restore the deployment's .env from .env.previous.",
    );
  return password;
}

async function prepare(s) {
  const { plan, context } = s;
  mkdirSync(plan.paths.root, { recursive: true, mode: 0o700 });
  chmodSync(plan.paths.root, 0o700);
  for (const directory of [plan.paths.state, plan.paths.host, plan.paths.logs])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(plan.paths.host, 0o700);
  mkdirSync(plan.paths.projectsFolder, { recursive: true });
  // Host-only installations make no Docker calls at all.
  if (plan.devContainer) {
    const files = describeServices(plan).map((service) => s.manager.file(service.label));
    assertProtectedPaths(
      [plan.paths.root, plan.paths.host, plan.paths.state, ...files, plan.executables.node],
      await writableBindRoots(plan.executables.docker, context.run),
    );
  }
  return {
    message: `Created ${plan.paths.root} for this account only, and the Projects folder ${plan.paths.projectsFolder}.`,
  };
}

/**
 * The installation identity is the plan's ID; this step adds the owner password and the
 * display name in the format of packages/server/.../installation-name.ts.
 */
async function identity(s) {
  const { plan, context } = s;
  if (!existsSync(plan.paths.ownerPassword))
    privateWrite(plan.paths.ownerPassword, context.secret() + "\n");
  const nameFile = path.join(plan.paths.coordinatorState, "installation-name.json");
  mkdirSync(plan.paths.coordinatorState, { recursive: true, mode: 0o700 });
  // An unset name means "Vorteo", so the default writes nothing.
  if (plan.name !== "Vorteo") privateWrite(nameFile, JSON.stringify({ name: plan.name }));
  return {
    message: `Installation ${plan.installationId} named "${plan.name}". Owner password saved to ${plan.paths.ownerPassword}.`,
  };
}

async function tailscale(s) {
  const { plan, context } = s;
  const executable = plan.executables.tailscale;
  let status = await tailscaleStatus(context, executable);
  if (status.backendState !== "Running" && plan.remote.authKeyFile) {
    try {
      // The key stays in its file; `file:` keeps it out of the process list.
      await context.run(executable, ["up", `--auth-key=file:${plan.remote.authKeyFile}`], {
        timeout: 120_000,
      });
    } catch (error) {
      throw new InstallerError(
        "Tailscale did not sign in with the auth key.",
        `Run \`sudo ${executable} up --auth-key=file:${plan.remote.authKeyFile}\`, then run apply again.`,
        { cause: error },
      );
    }
    status = await tailscaleStatus(context, executable);
  }
  if (status.backendState !== "Running" || !status.hostname)
    throw new InstallerError(
      "Tailscale is not signed in.",
      "Open Tailscale and sign in, then run apply again.",
    );
  if (plan.remote.hostname && plan.remote.hostname !== status.hostname)
    throw new InstallerError(
      `Tailscale is signed in as ${status.hostname}, not ${plan.remote.hostname} as planned.`,
      "Plan again so the addresses match this machine's tailnet name.",
    );
  s.journal.output({ hostname: status.hostname, origin: publicOrigin(plan, status.hostname) });
  return { message: `Tailscale is signed in as ${status.hostname}.` };
}

async function devImages(s) {
  const { plan, context, outputs } = s;
  const docker = plan.executables.docker;
  const exists = async (image) => {
    try {
      await context.run(docker, ["image", "inspect", image]);
      return true;
    } catch {
      return false;
    }
  };
  if (
    outputs.devImage &&
    outputs.gateImage &&
    (await exists(outputs.devImage)) &&
    (await exists(outputs.gateImage))
  )
    return { skip: "The images already exist." };
  // VORTEO_DEV_IMAGE names a prebuilt image of this revision, as test runs build it ahead.
  const prebuilt = context.env?.VORTEO_DEV_IMAGE;
  if (prebuilt) {
    const gateImage = await context.run(
      "bash",
      [path.join(plan.paths.source, "docker/gate/build.sh")],
      { env: scriptEnvironment(s), timeout: 30 * 60_000 },
    );
    s.journal.output({ devImage: prebuilt, gateImage });
    return { message: "Used the prebuilt Dev image and built the gate image." };
  }
  const receipt = path.join(plan.paths.state, "dev-image.iid");
  await build(
    docker,
    [
      "build",
      "--build-arg",
      `PASEO_BUILD_COMMIT=${plan.revision}`,
      "--iidfile",
      receipt,
      "-f",
      path.join(plan.paths.source, "docker/base/Dockerfile"),
      plan.paths.source,
    ],
    plan.paths.source,
    path.join(plan.paths.logs, "dev-image.log"),
    {},
    context.run,
  );
  const devImage = readFileSync(receipt, "utf8").trim();
  const gateImage = await context.run(
    "bash",
    [path.join(plan.paths.source, "docker/gate/build.sh")],
    {
      env: scriptEnvironment(s),
      timeout: 30 * 60_000,
    },
  );
  s.journal.output({ devImage, gateImage });
  return { message: "Built the Dev image and the gate image." };
}

async function devCreate(s) {
  const { plan, context, outputs } = s;
  const deployment = plan.paths.container;
  if (existsSync(path.join(deployment, ".container-installation"))) {
    await composeUp(s, deployment);
    return { message: `Dev in ${deployment} is running.` };
  }
  if (existsSync(deployment))
    throw new InstallerError(
      `${deployment} exists but holds no deployment.`,
      `Move ${deployment} aside, then run apply again.`,
    );
  await context.run(
    "bash",
    [path.join(plan.paths.source, "docker/multiplex/install.sh"), deployment, outputs.devImage],
    {
      env: scriptEnvironment(s, gateEnvironment(s)),
      timeout: 15 * 60_000,
    },
  );
  return {
    message: `Created Dev in ${deployment}, reachable from the Host at 127.0.0.1:${plan.ports.devRelay}.`,
  };
}

/**
 * Refreshes the deployment's lifecycle scripts, keeping each replaced file once as
 * <name>.before-installer, then runs its gate.sh, which rolls back on failure.
 * Data folders are never moved or changed.
 */
async function devAdopt(s) {
  const { plan, context, outputs } = s;
  const deployment = plan.dev.legacy.path;
  if (existsSync(path.join(deployment, ".gate-mode"))) {
    await composeUp(s, deployment);
    return { message: `Dev in ${deployment} already runs in gate mode.` };
  }
  for (const name of DEPLOYMENT_SCRIPTS) {
    const source = path.join(plan.paths.source, "docker/multiplex", name);
    const target = path.join(deployment, name);
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) === sha256(readFileSync(source))) continue;
      const backup = `${target}.before-installer`;
      if (!existsSync(backup)) copyFileSync(target, backup);
    }
    copyFileSync(source, target);
    chmodSync(target, name.endsWith(".sh") ? 0o700 : 0o600);
  }
  await context.run("bash", [path.join(deployment, "gate.sh"), "enable"], {
    env: scriptEnvironment(s, { ...gateEnvironment(s), PASEO_IMAGE: outputs.devImage }),
    timeout: 15 * 60_000,
  });
  return {
    message: `Dev in ${deployment} now runs behind the gate, with its identity, home and workspace kept.`,
  };
}

async function devIdentity(s) {
  const { plan, context } = s;
  const instance =
    plan.dev.instance ?? readEnvFile(path.join(plan.paths.container, ".env")).PASEO_INSTANCE;
  if (!instance)
    throw new InstallerError(
      "The Dev deployment has no instance name.",
      "Restore the deployment's .env from .env.previous.",
    );
  s.journal.output({ instance });
  const containerServerId = await readContainerServerId({
    docker: plan.executables.docker,
    containerName: containerName(s),
    containerUser: plan.dev.user,
    containerDaemonHome: plan.dev.daemonHome,
    runCommand: context.run,
  });
  if (!/^srv_[A-Za-z0-9_-]+$/.test(containerServerId))
    throw new InstallerError(
      "Dev has no daemon identity yet.",
      "Wait until Dev reports healthy, then run apply again.",
    );
  s.journal.output({ containerServerId });
  return { message: `Dev is ${containerServerId}.` };
}

async function release(s) {
  const { plan, context } = s;
  const marker = path.join(plan.paths.release, ".installer-release.json");
  if (existsSync(marker)) return { skip: "The release is already built." };
  const nodeDirectory = path.dirname(plan.executables.node);
  const tools = { npm: plan.executables.npm, git: plan.executables.git };
  await buildRelease({
    release: plan.paths.release,
    revision: plan.revision,
    sourceDirectory: plan.paths.source,
    logDir: plan.paths.logs,
    runCommand: (command, args, options = {}) =>
      context.run(tools[command] ?? command, args, {
        ...options,
        env: { ...process.env, ...options.env, PATH: `${nodeDirectory}:${process.env.PATH ?? ""}` },
      }),
  });
  writeJson(marker, { revision: plan.revision, builtAt: context.now().toISOString() });
  // A Host installation upgraded in place selects its releases in adopt-links.
  if (plan.kind !== "adopt-host") selectRelease(plan);
  return { message: `Built release ${plan.revision.slice(0, 12)}.` };
}

/** Points both service links at this plan's release, replacing each link atomically. */
export function selectRelease(
  plan,
  links = [plan.paths.hostReleaseLink, plan.paths.coordinatorReleaseLink],
) {
  for (const link of links) pointLink(link, plan.paths.release);
}

export function pointLink(link, target) {
  const next = `${link}.next`;
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, link);
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hostConfig(s) {
  const { plan, context, outputs, manager } = s;
  if (existsSync(plan.paths.record)) return { skip: "The configuration is already written." };
  const modules = await serverModules(s);
  mkdirSync(plan.paths.hostHome, { recursive: true, mode: 0o700 });
  mkdirSync(plan.paths.coordinatorState, { recursive: true, mode: 0o700 });
  const hostServerId = modules.getOrCreateServerId(plan.paths.hostHome, { env: {} });
  const ownerPassword = readFileSync(plan.paths.ownerPassword, "utf8").trim();
  const hostPassword = context.secret();
  const hostToken = context.secret();
  const containerToken = context.secret();
  const origin = publicOrigin(plan, outputs.hostname);
  const config = buildCoordinatorConfig({
    plan,
    hostname: outputs.hostname,
    hostServerId,
    containerServerId: outputs.containerServerId,
    hostPassword,
    containerPassword: plan.devContainer ? devPassword(s) : undefined,
    hashes: {
      owner: modules.hashDaemonPassword(ownerPassword),
      hostAgent: hashToken(hostToken),
      containerAgent: hashToken(containerToken),
    },
    hostService: manager.descriptor(plan.services.host),
    coordinatorService: manager.descriptor(plan.services.coordinator),
  });
  const clientFile = hostClientFile(plan);
  writeJson(clientFile, {
    origin: `http://127.0.0.1:${plan.ports.coordinator}`,
    publicOrigin: origin,
    token: hostToken,
    kind: "host-agent",
  });
  // Kept for the guest-client step; installGuestClient copies it into Dev.
  if (plan.devContainer)
    writeJson(path.join(plan.paths.host, "container-agent.json"), {
      origin: devClientOrigin(plan, outputs.hostname),
      token: containerToken,
      kind: "container-agent",
    });
  const skillFile = path.join(plan.paths.host, "skills/installation-maintenance/SKILL.md");
  privateWrite(
    skillFile,
    renderSkill(
      readFileSync(path.join(plan.paths.release, INSTALLATION_SKILL), "utf8"),
      origin,
      `${shellQuote(plan.executables.node)} ${shellQuote(path.join(plan.paths.hostReleaseLink, AGENT_SCRIPT))} --config ${shellQuote(clientFile)}`,
    ),
  );
  writeJson(
    path.join(plan.paths.hostHome, "config.json"),
    hostDaemonConfig({
      hostPort: plan.ports.host,
      hostnames: plan.remote.mode === "tailscale" ? [outputs.hostname] : [],
      passwordHash: modules.hashDaemonPassword(hostPassword),
      origins: interfaceOrigins(plan, outputs.hostname),
      skillFile,
    }),
  );
  // The System project branches new workspaces from the source checkout.
  writeSystemSource({
    paseoHome: plan.paths.hostHome,
    checkout: plan.paths.source,
    ref: plan.revision,
  });
  writeProjectsFolderSettings({
    paseoHome: plan.paths.hostHome,
    root: realpathSync(plan.paths.projectsFolder),
  });
  writeJson(plan.paths.coordinatorConfig, config);
  const labels = Object.fromEntries(
    describeServices(plan).map((service) => [service.role, service.label]),
  );
  // Written last: its presence marks this step complete and the installation as current.
  writeJson(plan.paths.record, {
    version: 1,
    installationId: plan.installationId,
    revision: plan.revision,
    root: plan.paths.host,
    release: plan.paths.release,
    origin,
    configFile: plan.paths.coordinatorConfig,
    hostHome: plan.paths.hostHome,
    serviceManager: manager.kind,
    hostServiceFile: manager.file(labels.host),
    coordinatorServiceFile: manager.file(labels.coordinator),
    hostService: manager.service(labels.host),
    coordinatorService: manager.service(labels.coordinator),
    plan: {
      docker: plan.executables.docker,
      tailscale: plan.executables.tailscale,
      httpsPort: plan.ports.https,
      hostHttpsPort: plan.ports.hostHttps,
    },
    phase: "prepared",
  });
  s.journal.output({ origin });
  return { message: `Wrote ${plan.paths.coordinatorConfig}.` };
}

async function devPair(s) {
  const { plan, context, outputs } = s;
  const modules = await serverModules(s);
  const result = await pairContainerOrigin({
    config: readJson(plan.paths.coordinatorConfig),
    connectInstallationDaemon: modules.connectInstallationDaemon,
    docker: plan.executables.docker,
    containerName: containerName(s),
    containerUser: plan.dev.user,
    containerCli: plan.dev.cli,
    containerDaemonHome: plan.dev.daemonHome,
    containerServerId: outputs.containerServerId,
    origin: publicOrigin(plan, outputs.hostname),
    root: plan.paths.host,
    runCommand: context.run,
  });
  return {
    message: result.changed
      ? "Dev now accepts the installation's interface."
      : "Dev already accepts the installation's interface.",
  };
}

async function services(s) {
  const { plan, manager } = s;
  const definitions = describeServices(plan);
  for (const service of definitions) manager.write(service);
  for (const service of definitions) await manager.start(service.label);
  const [warning] = await manager.preflight();
  const message = `Started ${definitions.map((service) => service.label).join(" and ")}.`;
  return warning ? { message: `${message} ${warning.message}`, fix: warning.fix } : { message };
}

async function ready(s) {
  const modules = await serverModules(s);
  await waitForInstallation(
    readJson(s.plan.paths.coordinatorConfig),
    modules.connectInstallationDaemon,
    {
      fetchImpl: s.context.fetch,
      ...(s.context.readyTimeoutMs ? { timeoutMs: s.context.readyTimeoutMs, intervalMs: 10 } : {}),
    },
  );
  return { message: "The Host daemon and coordinator are ready." };
}

export function remoteRoutes(plan) {
  // A Host installation upgraded in place already serves its own routes; it adds Dev's.
  const own =
    plan.kind === "adopt-host"
      ? []
      : [
          [plan.ports.https, plan.ports.coordinator],
          [plan.ports.hostHttps, plan.ports.host],
        ];
  return [...own, ...(plan.devContainer ? [[plan.ports.devHttps, plan.ports.devRelay]] : [])].map(
    ([port, local]) => ({ port, target: `http://127.0.0.1:${local}` }),
  );
}

async function remote(s) {
  const { plan, context, outputs } = s;
  const executable = plan.executables.tailscale;
  const serve = JSON.parse(await context.run(executable, ["serve", "status", "--json"]));
  const added = [];
  for (const { port, target } of remoteRoutes(plan)) {
    const current = serveRouteTarget(serve, outputs.hostname, port);
    if (current === target) continue;
    if (current || serve.TCP?.[String(port)] || serve.AllowFunnel?.[`${outputs.hostname}:${port}`])
      throw new InstallerError(
        `Tailscale HTTPS port ${port} already belongs to another service.`,
        "Plan again to choose free ports, then apply the new plan.",
      );
    try {
      await context.run(executable, ["serve", "--bg", `--https=${port}`, target]);
    } catch (error) {
      // Linux tailscaled accepts serve changes only from root or its operator.
      throw new InstallerError(
        `Tailscale refused the HTTPS route on port ${port}.`,
        plan.platform === "linux"
          ? `Run \`sudo ${executable} set --operator=$USER\`, then run apply again.`
          : "Check that Tailscale is running and signed in, then run apply again.",
        { cause: error },
      );
    }
    added.push(port);
  }
  return {
    message: added.length
      ? `Added HTTPS routes on ports ${added.join(", ")}.`
      : "The HTTPS routes already exist.",
  };
}

/** Dev agents reach the coordinator through the tailnet origin or, without Tailscale, the gate. */
async function guestClient(s) {
  const { plan, context, outputs } = s;
  const { token } = readJson(path.join(plan.paths.host, "container-agent.json"));
  await installGuestClient({
    docker: plan.executables.docker,
    containerName: containerName(s),
    containerUser: plan.dev.user,
    origin: devClientOrigin(plan, outputs.hostname),
    token,
    root: plan.paths.host,
    release: plan.paths.hostReleaseLink,
    runCommand: context.run,
  });
  return { message: "Dev agents can request installation changes." };
}

async function finish(s) {
  const record = readJson(s.plan.paths.record);
  writeJson(s.plan.paths.record, { ...record, phase: "started" });
  s.journal.complete();
  return { message: "The installation is ready." };
}

export const STEPS = {
  prepare,
  identity,
  tailscale,
  "dev-images": devImages,
  "dev-create": devCreate,
  "dev-adopt": devAdopt,
  "dev-identity": devIdentity,
  release,
  "host-config": hostConfig,
  "dev-pair": devPair,
  services,
  ready,
  remote,
  "guest-client": guestClient,
  finish,
};
