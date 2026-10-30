// Upgrades a Host installation made before the one-command installer
// (scripts/install-execution-host.mjs `install`, from a hand-written plan) in place.
// Its root holds installation.json, coordinator.json, owner-password, releases/, state/
// and logs/, which is the installer's `host` folder; the root never moves.
//
// The plan adds what the installer layout has and the old root lacks: a `source`
// checkout, the `host-current` and `coordinator-current` release links that the services
// run through, the coordinator's `deployment` block, connect-once provider accounts,
// Dev in gate mode behind a Tailscale route on the Host, and an install journal at
// state/install.json so `host-release`, status and repair work afterwards.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPlan } from "./apply.mjs";
import { gateRoute } from "./coordinator-config.mjs";
import {
  JOURNAL,
  LAB_DIRECTORY,
  findLegacyDeployments,
  inspectHostRoot,
  serviceArguments,
  tailscaleStatus,
} from "./detect.mjs";
import { COORDINATOR_ENTRYPOINT, SUPERVISOR_ENTRYPOINT } from "./host-installation.mjs";
import { createLaunchdManager } from "./launchd.mjs";
import { choosePorts, servePortsInUse } from "./ports.mjs";
import { PLAN_VERSION, npmPath, planDev } from "./plan.mjs";
import { InstallerError, privateWrite, within, writeJson } from "./primitives.mjs";
import { pointLink } from "./steps.mjs";
import { createSystemdManager } from "./systemd.mjs";
import { readJournal } from "./journal.mjs";
import { PROJECTS_FOLDER_SETTINGS_PATH } from "../lib/projects-folder.mjs";
import { SYSTEM_SETTINGS_PATH } from "../lib/system-source.mjs";

export const VORTEO_GIT_URL = "https://github.com/terran-labs/vorteo.git";
const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_MODULE = "packages/server/dist/server/server/execution-installation/config.js";
const COMMIT = /^[0-9a-f]{40}$/;
// docker/multiplex/common.sh accepts only these characters in a bind-mounted folder.
const COMPOSE_SAFE_PATH = /^\/[A-Za-z0-9._/@+-]+$/;
// Service files are edited as text, so a path must need no XML or systemd escaping.
const PLAIN_PATH = /^\/[A-Za-z0-9._/@+-]+$/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The commit a built release holds, from the markers each builder writes, or null. */
export function releaseRevision(release) {
  const installer = readJson(path.join(release, ".installer-release.json"));
  if (COMMIT.test(installer?.revision ?? "")) return installer.revision;
  const source = readJson(path.join(release, ".installation-source.json"));
  if (COMMIT.test(source?.sourceCommit ?? "")) return source.sourceCommit;
  // scripts/install-execution-host.mjs names each release folder by its commit.
  const name = path.basename(release);
  return COMMIT.test(name) ? name : null;
}

/** The commit this engine runs from: a built release's marker or the checkout's HEAD. */
async function engineRevision(context, git) {
  if (context.engineRevision) return context.engineRevision;
  const marked = releaseRevision(ENGINE_ROOT);
  if (marked) return marked;
  try {
    const head = await context.run(git, ["rev-parse", "HEAD"], { cwd: ENGINE_ROOT });
    if (COMMIT.test(head)) return head;
  } catch {
    /* not a checkout */
  }
  throw new InstallerError(
    "The installer cannot tell which commit it runs from.",
    "Run the installer from a release checkout, or pass --revision <commit>.",
  );
}

function serviceManager(kind, context) {
  const options = {
    run: context.run,
    uid: context.uid,
    home: context.home,
    user: context.user,
    sleep: context.sleep,
  };
  return kind === "launchd" ? createLaunchdManager(options) : createSystemdManager(options);
}

/** Labels and manager of the old services, from the coordinator's Host descriptor and the record. */
function legacyServices(config, record) {
  if (config.host.launchdService) {
    const label = (service) => /^gui\/\d+\/(.+)$/.exec(service ?? "")?.[1];
    return {
      manager: "launchd",
      host: label(config.host.launchdService),
      coordinator:
        label(record.coordinatorService) ?? `local.vorteo.${record.installationId}.installation`,
    };
  }
  const unit = config.host.systemdService?.unit ?? "";
  return {
    manager: "systemd-user",
    host: unit.replace(/\.service$/, ""),
    coordinator: `local.vorteo.${record.installationId}.installation`,
  };
}

/** The release folder a service runs `entrypoint` from, following an existing link. */
function serviceRelease(file, entrypoint, link) {
  let argv;
  try {
    argv = serviceArguments(readFileSync(file, "utf8"));
  } catch {
    throw new InstallerError(
      `The service file ${file} is missing.`,
      "Run the installer on the Host where this installation's services are registered.",
    );
  }
  const linked = path.join(link, entrypoint);
  if (argv.includes(linked)) return { release: realpathSync(link), node: argv[0], linked: true };
  const arg = argv.find((value) => value.endsWith(`/${entrypoint}`));
  if (!arg)
    throw new InstallerError(
      `${file} does not start ${entrypoint} from a release folder, so it cannot be repointed.`,
      "Restore the service file the original installer wrote, then run the installer again.",
    );
  return { release: arg.slice(0, -entrypoint.length - 1), node: argv[0], linked: false };
}

function endpointPort(endpoint) {
  return Number(/:(\d+)$/.exec(endpoint)?.[1]);
}

/** Dev's deployment: the one whose loopback port (or gate relay) is the coordinator's endpoint. */
async function legacyDevDeployment(context, config, root) {
  const port = endpointPort(config.container.endpoint);
  const deployments = await findLegacyDeployments(context, {
    exclude: [root],
    extra: [path.join(context.home, LAB_DIRECTORY, "container")],
  });
  const match = deployments.find(
    (deployment) => (deployment.gateMode ? deployment.relayPort : deployment.loopbackPort) === port,
  );
  if (!match)
    throw new InstallerError(
      `No Dev deployment publishes 127.0.0.1:${port}, the endpoint this installation uses for Dev.`,
      "Start the Dev container with its docker/multiplex deployment, then run the installer again.",
    );
  return match;
}

function projectsFolderOf(deployment, hostHome) {
  const host = readJson(path.join(hostHome, PROJECTS_FOLDER_SETTINGS_PATH));
  const folder = deployment.projectsFolder ?? host?.root;
  if (!folder || !existsSync(folder))
    throw new InstallerError(
      "Dev has no Projects folder to mount in gate mode.",
      `Configure one first: node scripts/install-execution-host.mjs configure-projects-folder --root <root> --folder <path>.`,
    );
  if (!COMPOSE_SAFE_PATH.test(folder))
    throw new InstallerError(
      `The Dev container cannot mount ${folder} in gate mode.`,
      "Move the Projects folder to a path with only letters, digits and ._@+- characters.",
    );
  return folder;
}

/** Local repositories that may hold the needed commits, best first, then GitHub. */
function sourceOrigins(config, hostHome, source) {
  const system = readJson(path.join(hostHome, SYSTEM_SETTINGS_PATH))?.source?.checkout;
  const local = [config.sourceUpdates?.sourceRepository, source, system].filter(
    (directory) => typeof directory === "string" && existsSync(directory),
  );
  return [...new Set(local), VORTEO_GIT_URL];
}

function installationName(stateDir) {
  const name = readJson(path.join(stateDir, "installation-name.json"))?.name;
  return typeof name === "string" && name.trim() ? name : "Vorteo";
}

function authority(origin) {
  const url = new URL(origin);
  return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

async function tailnet(context, tailscale) {
  const status = await tailscaleStatus(context, tailscale);
  if (status.backendState !== "Running" || !status.hostname)
    throw new InstallerError(
      "Tailscale is not signed in on this Host.",
      "Open Tailscale and sign in, then run the installer again.",
    );
  let serve = {};
  try {
    serve = JSON.parse(await context.run(tailscale, ["serve", "status", "--json"]));
  } catch {
    /* no routes yet */
  }
  return { hostname: status.hostname, servePorts: servePortsInUse(serve, status.hostname) };
}

export function adoptionSteps({ devContainer, tailscale, build }) {
  return [
    "adopt-backup",
    ...(tailscale ? ["tailscale"] : []),
    "adopt-source",
    ...(build ? ["release"] : []),
    ...(devContainer ? ["dev-images", "dev-adopt", "dev-identity"] : []),
    "adopt-links",
    "adopt-config",
    "adopt-services",
    ...(tailscale && devContainer ? ["remote"] : []),
    "adopt-restart",
    "ready",
    "finish",
  ];
}

function assertAdoptable(context) {
  const host = inspectHostRoot(context.root);
  if (host?.kind === "legacy-host") return host;
  if (host?.kind === "current")
    throw new InstallerError(
      `${context.root} already uses the installer layout.`,
      "Upgrade it from Installation controls, or run `main.mjs repair`.",
    );
  throw new InstallerError(
    `${context.root} holds no Host installation made by scripts/install-execution-host.mjs.`,
    "Pass that installation's folder, the one holding installation.json, with --root.",
  );
}

async function devPlan(context, config, root, hostHome, docker) {
  const deployment = await legacyDevDeployment(context, config, root);
  const dev = await planDev(context, docker, { kind: "legacy-host" }, deployment);
  return { dev, deployment, projectsFolder: projectsFolderOf(deployment, hostHome) };
}

/** The adoption's own settings: which releases it starts from and which service files it edits. */
function adoptionDetails({ config, services, paths, links, current, build }) {
  const host = config.sourceUpdates ? null : current.host;
  const target = paths.release;
  const edits = [
    {
      file: services.coordinatorFile,
      from: path.join(current.coordinator.release, COORDINATOR_ENTRYPOINT),
      to: path.join(links.coordinator, COORDINATOR_ENTRYPOINT),
    },
    ...(host
      ? [
          {
            file: services.hostFile,
            from: path.join(host.release, SUPERVISOR_ENTRYPOINT),
            to: path.join(links.host, SUPERVISOR_ENTRYPOINT),
          },
        ]
      : []),
  ].filter((edit) => edit.from !== edit.to);
  for (const edit of edits)
    if (!PLAIN_PATH.test(edit.from) || !PLAIN_PATH.test(edit.to))
      throw new InstallerError(
        `The release path ${edit.from} has characters the installer does not edit in service files.`,
        "Move the installation to a path with only letters, digits and ._@+- characters.",
      );
  let hostTarget = null;
  if (host) hostTarget = build ? target : host.release;
  return {
    sourceUpdates: Boolean(config.sourceUpdates),
    build,
    record: path.join(paths.root, "installation.json"),
    previousReleases: [current.coordinator.release, ...(host ? [host.release] : [])],
    coordinatorRelease: current.coordinator.release,
    hostTarget,
    restartHost: Boolean(host) && (build || !host.linked),
    serviceEdits: edits,
    hostServiceFile: services.hostFile,
    coordinatorServiceFile: services.coordinatorFile,
  };
}

/** An executable the original plan named by absolute path, or the one on PATH. */
function legacyExecutable(context, recorded, name) {
  return path.isAbsolute(recorded ?? "") ? recorded : context.which(name);
}

/** The old ports, plus a free Tailscale HTTPS port for Dev's new route. */
async function adoptionPorts(context, { config, record, dev, servePorts, tailscale }) {
  const ports = { coordinator: config.listenPort, host: endpointPort(config.host.endpoint) };
  if (record.plan?.httpsPort) ports.https = record.plan.httpsPort;
  if (record.plan?.hostHttpsPort) ports.hostHttps = record.plan.hostHttpsPort;
  if (!dev) return ports;
  ports.devRelay = endpointPort(config.container.endpoint);
  if (!tailscale) return ports;
  const owned = [ports.https, ports.hostHttps].filter(Boolean);
  const chosen = await choosePorts({
    wanted: ["devHttps"],
    isPortFree: context.isPortFree,
    servePorts: new Set([...servePorts, ...owned]),
  });
  return { ...ports, ...chosen };
}

function adoptionPaths({ context, found, config, hostHome, release, links, dev }) {
  const root = found.root;
  return {
    home: context.home,
    root,
    source: path.join(root, "source"),
    host: root,
    state: path.join(root, "state"),
    journal: path.join(root, JOURNAL),
    ownerPassword: config.ownerPasswordFile ?? path.join(root, "owner-password"),
    record: path.join(root, "installation.json"),
    coordinatorConfig: found.configFile,
    coordinatorState: config.stateDir,
    hostHome,
    release,
    hostReleaseLink: links.host,
    coordinatorReleaseLink: links.coordinator,
    logs: path.join(root, "logs"),
    ...(dev ? { projectsFolder: dev.projectsFolder, container: dev.deployment.path } : {}),
  };
}

/** The old services, the release links they move to and the releases they run now. */
function legacyReleases(context, config, record, root) {
  const services = legacyServices(config, record);
  const manager = serviceManager(services.manager, context);
  const links = {
    host: config.sourceUpdates
      ? config.sourceUpdates.currentReleaseLink
      : path.join(root, "releases", "host-current"),
    coordinator: path.join(root, "releases", "coordinator-current"),
  };
  const files = {
    hostFile: manager.file(services.host),
    coordinatorFile: manager.file(services.coordinator),
  };
  const current = {
    coordinator: serviceRelease(files.coordinatorFile, COORDINATOR_ENTRYPOINT, links.coordinator),
    // Host source updates own the Host's release selection; adoption leaves it alone.
    host: config.sourceUpdates
      ? null
      : serviceRelease(files.hostFile, SUPERVISOR_ENTRYPOINT, links.host),
  };
  return { services, links, files, current };
}

/** Docker for Dev, and Tailscale with this Host's tailnet name and the serve ports in use. */
async function legacyTools(context, config, record) {
  const tailscale = (config.access?.remote ?? "tailscale") === "tailscale";
  const docker = config.container
    ? legacyExecutable(context, record.plan?.docker, "docker")
    : undefined;
  if (config.container && !docker)
    throw new InstallerError("Dev needs Docker, which is not installed.", "Install Docker first.");
  if (!tailscale) return { tailscale, docker, hostname: null, servePorts: new Set() };
  const executable = legacyExecutable(context, record.plan?.tailscale, "tailscale");
  return { tailscale, docker, executable, ...(await tailnet(context, executable)) };
}

function devSettings(dev, config, tailscale) {
  if (!dev) return {};
  return {
    dev: {
      ...dev.dev,
      extraOrigins: [config.recoveryOrigin].filter(Boolean),
      extraRoutes: tailscale ? [authority(config.public.origin)] : [],
    },
  };
}

async function planRevision(context, requested, git) {
  const revision = requested ?? (await engineRevision(context, git));
  if (!COMMIT.test(revision))
    throw new InstallerError(`${revision} is not a full commit.`, "Pass a 40-character commit.");
  return revision;
}

/**
 * Plans the in-place upgrade of the old Host root at context.root. `source` is a checkout
 * that holds this engine's commit, such as the release install.sh fetched; `revision`
 * overrides the engine's own commit. Changes nothing.
 *
 * @returns {Promise<{ plan: object, summary: string[] }>}
 */
export async function createHostAdoptionPlan(context, { source, revision: requested } = {}) {
  const found = assertAdoptable(context);
  const record = readJson(path.join(found.root, "installation.json"));
  const config = readJson(found.configFile);
  const git = context.which("git");
  if (!git) throw new InstallerError("Git is required.", "Install Git, then run it again.");
  const revision = await planRevision(context, requested, git);
  const { services, links, files, current } = legacyReleases(context, config, record, found.root);
  // The coordinator restarts on the new configuration, so it must run a release that
  // reads it. Without that release here, adoption builds this engine's commit.
  const build = releaseRevision(current.coordinator.release) !== revision;
  const hostHome = config.host.startupValidation?.home ?? record.hostHome;
  const tools = await legacyTools(context, config, record);
  const { tailscale, docker, hostname, servePorts } = tools;
  const dev = config.container
    ? await devPlan(context, config, found.root, hostHome, docker)
    : null;
  const ports = await adoptionPorts(context, { config, record, dev, servePorts, tailscale });
  const release = build ? path.join(found.root, "releases", revision) : current.coordinator.release;
  const paths = adoptionPaths({ context, found, config, hostHome, release, links, dev });
  const plan = {
    version: PLAN_VERSION,
    installationId: record.installationId,
    createdAt: context.now().toISOString(),
    platform: context.platform,
    kind: "adopt-host",
    name: installationName(config.stateDir),
    revision,
    origin: config.public.origin,
    devContainer: Boolean(dev),
    remote: { mode: tailscale ? "tailscale" : "local", ...(hostname ? { hostname } : {}) },
    ports,
    paths,
    services,
    executables: {
      node: config.host.startupValidation?.node ?? current.coordinator.node ?? context.execPath,
      git,
      npm: npmPath(context),
      ...(docker ? { docker } : {}),
      ...(tools.executable ? { tailscale: tools.executable } : {}),
    },
    ...devSettings(dev, config, tailscale),
    adoption: {
      ...adoptionDetails({ config, services: files, paths, links, current, build }),
      sourceOrigins: sourceOrigins(config, hostHome, source),
    },
    steps: adoptionSteps({ devContainer: Boolean(dev), tailscale, build }),
  };
  return { plan, summary: summarizeAdoption(plan) };
}

export function summarizeAdoption(plan) {
  const { adoption, paths } = plan;
  const lines = [
    `Upgrade the existing installation "${plan.name}" in ${paths.root} in place. Its identity, owner password, homes, agents and data stay where they are.`,
    `Source: ${paths.source}, a checkout at ${plan.revision.slice(0, 12)}.`,
  ];
  lines.push(
    adoption.build
      ? `Build release ${plan.revision.slice(0, 12)} and run the coordinator${adoption.hostTarget ? " and the Host daemon" : ""} from it.`
      : "Keep the releases the services run now.",
  );
  lines.push(
    adoption.sourceUpdates
      ? `The coordinator runs through ${paths.coordinatorReleaseLink}; the Host keeps ${paths.hostReleaseLink} from Host source updates.`
      : `The Host daemon and coordinator run through ${paths.hostReleaseLink} and ${paths.coordinatorReleaseLink}, so upgrades from the interface replace them.`,
  );
  if (plan.devContainer) {
    lines.push(
      `Dev in ${paths.container} moves to gate mode with automatic rollback, on ${plan.dev.subnet}. Its identity, home and workspace are kept.`,
    );
    if (plan.remote.mode === "tailscale")
      lines.push(
        `The interface reaches Dev at ${plan.remote.hostname}:${plan.ports.devHttps}, a new Tailscale HTTPS route to 127.0.0.1:${plan.ports.devRelay}.`,
      );
  }
  lines.push("Claude and Codex accounts connect once for the whole installation.");
  lines.push(
    `The coordinator${adoption.restartHost ? " and the Host daemon" : ""} restart through ${plan.services.manager === "launchd" ? "their launchd agents" : "their systemd user services"}; running agents are interrupted.`,
  );
  lines.push(
    `The previous configuration is kept as *.before-adoption, the service files in ${paths.state}/adoption.`,
  );
  return lines;
}

// Steps -------------------------------------------------------------------------------

export const ADOPTION_STEP_TITLES = {
  "adopt-backup": "Saving the current configuration",
  "adopt-source": "Preparing the source checkout",
  "adopt-links": "Creating the release links",
  "adopt-config": "Writing the coordinator configuration",
  "adopt-services": "Pointing the services at the release links",
  "adopt-restart": "Restarting the installation's services",
};

/** Keeps `file` once as <name>.before-adoption, in `directory` or beside it. */
function backup(file, directory = path.dirname(file)) {
  const saved = path.join(directory, `${path.basename(file)}.before-adoption`);
  if (!existsSync(file) || existsSync(saved)) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(file, saved);
}

async function containerId(s) {
  return s.context.run(s.plan.executables.docker, [
    "inspect",
    "--format",
    "{{.Id}}",
    `${s.plan.dev.instance}-paseo-1`,
  ]);
}

/** Keeps the files adoption changes, once, and the Dev container's ID before gate mode. */
async function adoptBackup(s) {
  const { plan } = s;
  for (const file of [plan.paths.coordinatorConfig, plan.adoption.record]) backup(file);
  // Service managers read every file in their folders, so service backups live in state.
  const saved = path.join(plan.paths.state, "adoption");
  for (const file of [plan.adoption.hostServiceFile, plan.adoption.coordinatorServiceFile])
    backup(file, saved);
  if (plan.devContainer && !s.outputs.previousContainerId) {
    try {
      s.journal.output({ previousContainerId: await containerId(s) });
    } catch {
      /* a stopped Dev has no container to pin */
    }
  }
  return {
    message: `Kept the configuration as *.before-adoption, and the service files in ${saved}.`,
  };
}

async function hasCommit(s, directory) {
  try {
    await s.context.run(s.plan.executables.git, [
      "-C",
      directory,
      "cat-file",
      "-e",
      `${s.plan.revision}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Clones the installation's own checkout and checks out this engine's commit. */
async function adoptSource(s) {
  const { plan, context } = s;
  const git = plan.executables.git;
  const source = plan.paths.source;
  const origins = plan.adoption.sourceOrigins;
  if (!existsSync(path.join(source, ".git"))) {
    const partial = `${source}.partial`;
    let cloned = false;
    for (const origin of origins) {
      rmSync(partial, { recursive: true, force: true });
      try {
        await context.run(git, ["clone", "--quiet", "--no-checkout", origin, partial], {
          timeout: 30 * 60_000,
        });
        cloned = true;
        break;
      } catch {
        /* try the next origin */
      }
    }
    if (!cloned)
      throw new InstallerError(
        "Could not clone the Vorteo source.",
        "Check your internet connection, then run the installer again.",
      );
    renameSync(partial, source);
  }
  for (const origin of origins) {
    if (await hasCommit(s, source)) break;
    try {
      await context.run(git, ["-C", source, "fetch", "--quiet", origin, plan.revision], {
        timeout: 30 * 60_000,
      });
    } catch {
      /* try the next origin */
    }
  }
  if (!(await hasCommit(s, source)))
    throw new InstallerError(
      `No known repository has commit ${plan.revision}.`,
      "Run the installer from a published release.",
    );
  await context.run(git, [
    "-C",
    source,
    "-c",
    "advice.detachedHead=false",
    "checkout",
    "--quiet",
    "--force",
    "--detach",
    plan.revision,
  ]);
  return { message: `${source} is at ${plan.revision.slice(0, 12)}.` };
}

async function adoptLinks(s) {
  const { plan } = s;
  mkdirSync(path.dirname(plan.paths.coordinatorReleaseLink), { recursive: true, mode: 0o700 });
  if (plan.adoption.hostTarget) pointLink(plan.paths.hostReleaseLink, plan.adoption.hostTarget);
  pointLink(plan.paths.coordinatorReleaseLink, plan.paths.release);
  return {
    message: plan.adoption.hostTarget
      ? `${plan.paths.hostReleaseLink} and ${plan.paths.coordinatorReleaseLink} select their releases.`
      : `${plan.paths.coordinatorReleaseLink} selects the coordinator's release.`,
  };
}

/** Every string equal to `from`, anywhere in `value`, replaced by `to`. */
function replaceValue(value, from, to) {
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) return value.map((item) => replaceValue(item, from, to));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceValue(item, from, to)]),
    );
  return value;
}

/** A path inside one of `releases`, moved under `link`; any other path unchanged. */
function throughLink(file, releases, link) {
  const release = releases.find((candidate) => file && within(file, candidate));
  return release ? path.join(link, path.relative(release, file)) : file;
}

/**
 * The coordinator configuration after adoption: the deployment block, both connect-once
 * account flags, Dev's public endpoint on the Host's Tailscale route, release paths
 * through the links and Dev's new container ID. Credentials and identities are kept.
 */
export function adoptedCoordinatorConfig(config, { plan, manager, hostname, containerIds }) {
  const tailscale = plan.remote.mode === "tailscale";
  const { adoption, paths } = plan;
  const environments = config.public.environments.map((environment) =>
    environment.kind === "container"
      ? {
          ...environment,
          endpoint: tailscale
            ? `${hostname}:${plan.ports.devHttps}`
            : `127.0.0.1:${plan.ports.devRelay}`,
          useTls: tailscale,
        }
      : environment,
  );
  const containerHome = plan.devContainer ? path.join(paths.container, "data", "home") : null;
  let next = {
    ...config,
    public: { ...config.public, environments },
    access: config.access ?? { remote: tailscale ? "tailscale" : "none", ...gateRoute(plan) },
    deployment: {
      installRoot: paths.root,
      sourceDirectory: paths.source,
      hostHome: paths.hostHome,
      hostReleaseLink: paths.hostReleaseLink,
      coordinator: {
        releaseLink: paths.coordinatorReleaseLink,
        service: manager.descriptor(plan.services.coordinator),
      },
      ...(plan.devContainer
        ? {
            containerDirectory: paths.container,
            ...(existsSync(containerHome) ? { containerHome } : {}),
          }
        : {}),
    },
    claudeHostRefresh: true,
    codexHostRefresh: true,
  };
  if (!adoption.sourceUpdates) {
    next.webDistDir = throughLink(
      config.webDistDir,
      adoption.previousReleases,
      paths.coordinatorReleaseLink,
    );
    if (config.host.startupValidation)
      next.host = {
        ...config.host,
        startupValidation: {
          ...config.host.startupValidation,
          entrypoint: path.join(paths.hostReleaseLink, SUPERVISOR_ENTRYPOINT),
        },
      };
  }
  // Gate mode recreates Dev, so every pin of its container ID moves to the new one.
  if (containerIds?.previous && containerIds.next && containerIds.previous !== containerIds.next)
    next = replaceValue(next, containerIds.previous, containerIds.next);
  return next;
}

async function configReader(s) {
  if (s.context.configReader) return s.context.configReader;
  const module = await import(pathToFileURL(path.join(s.plan.paths.release, CONFIG_MODULE)));
  return module.readInstallationConfig;
}

function serverIdOf(config, kind) {
  return config.public.environments.find((environment) => environment.kind === kind)?.serverId;
}

async function adoptConfig(s) {
  const { plan, outputs, manager } = s;
  const file = plan.paths.coordinatorConfig;
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (config.deployment) return { skip: "The configuration already has its deployment." };
  if (plan.devContainer && outputs.containerServerId !== serverIdOf(config, "container"))
    throw new InstallerError(
      `Dev answers as ${outputs.containerServerId}, not ${serverIdOf(config, "container")} as this installation pins.`,
      "Start the Dev deployment this installation paired, then run the installer again.",
    );
  const next = adoptedCoordinatorConfig(config, {
    plan,
    manager,
    hostname: outputs.hostname,
    containerIds: plan.devContainer
      ? { previous: outputs.previousContainerId, next: await containerId(s) }
      : undefined,
  });
  // The release the coordinator restarts on must accept the file before it replaces the old one.
  const candidate = `${file}.adoption-candidate`;
  writeJson(candidate, next);
  try {
    (await configReader(s))(candidate);
  } catch (error) {
    rmSync(candidate, { force: true });
    throw new InstallerError(
      `The new coordinator configuration is invalid: ${error.message}`,
      "Report this message; the current configuration is unchanged.",
      { cause: error },
    );
  }
  renameSync(candidate, file);
  const record = JSON.parse(readFileSync(plan.adoption.record, "utf8"));
  writeJson(plan.adoption.record, {
    ...record,
    installRoot: plan.paths.root,
    release: plan.paths.release,
    adoptedAt: s.context.now().toISOString(),
  });
  s.journal.output({ origin: plan.origin });
  return { message: `Wrote ${file}; the previous one is ${file}.before-adoption.` };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Replaces each service's release entrypoint with the same path through its link. */
async function adoptServices(s) {
  const changed = [];
  for (const { file, from, to } of s.plan.adoption.serviceEdits) {
    const text = readFileSync(file, "utf8");
    if (!text.includes(from)) {
      if (text.includes(to)) continue;
      throw new InstallerError(
        `${file} changed since the plan and no longer starts ${from}.`,
        "Plan the upgrade again.",
      );
    }
    const next = text.split(from).join(to);
    if (sha256(next) !== sha256(text)) privateWrite(file, next);
    changed.push(path.basename(file));
  }
  return changed.length
    ? { message: `${changed.join(" and ")} now start through the release links.` }
    : { skip: "The services already start through the release links." };
}

/** Reloads the edited services, the coordinator last: it may be this command's parent. */
async function adoptRestart(s) {
  const { plan, manager } = s;
  if (plan.adoption.restartHost) await manager.reload(plan.services.host);
  await manager.reload(plan.services.coordinator);
  return {
    message: plan.adoption.restartHost
      ? "Restarted the Host daemon and the coordinator."
      : "Restarted the coordinator.",
  };
}

export const ADOPTION_STEPS = {
  "adopt-backup": adoptBackup,
  "adopt-source": adoptSource,
  "adopt-links": adoptLinks,
  "adopt-config": adoptConfig,
  "adopt-services": adoptServices,
  "adopt-restart": adoptRestart,
};

// Command -----------------------------------------------------------------------------

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** One adoption per installation at a time; a lock from a process that died is taken over. */
function acquireLock(root) {
  const lock = path.join(root, "state", "adoption.lock");
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const holder = Number(readJson(lock)?.pid);
  if (holder && holder !== process.pid && processAlive(holder))
    throw new InstallerError(
      `Another upgrade of this installation is running (process ${holder}).`,
      "Wait for it to finish; Installation controls show its progress.",
    );
  writeFileSync(lock, JSON.stringify({ pid: process.pid }) + "\n", { mode: 0o600 });
  return () => rmSync(lock, { force: true });
}

/**
 * Plans and applies the in-place upgrade of the old Host root at context.root, resuming a
 * started one from its journal. Writes `outcome` as {status, detail} when given, for the
 * coordinator that launched it. Returns true on success.
 */
export async function adoptHost(context, { source, revision, outcome }, emit) {
  const report = (value) =>
    outcome && writeFileSync(outcome, JSON.stringify(value) + "\n", { mode: 0o600 });
  let release = () => {};
  try {
    release = acquireLock(context.root);
    const journal = readJournal(path.join(context.root, JOURNAL));
    if (journal?.completedAt) {
      report({
        status: "succeeded",
        detail: "This installation already uses the installer layout.",
      });
      return true;
    }
    const plan =
      journal?.plan?.kind === "adopt-host"
        ? journal.plan
        : (await createHostAdoptionPlan(context, { source, revision })).plan;
    let failure = null;
    const ok = await applyPlan(plan, context, (line) => {
      if (line.status === "fail") failure = line;
      emit(line);
    });
    report(
      ok
        ? { status: "succeeded", detail: "The installation now uses the installer layout." }
        : {
            status: "failed",
            detail: failure?.message ?? "The upgrade failed.",
            ...(failure?.fix ? { fix: failure.fix } : {}),
          },
    );
    return ok;
  } catch (error) {
    report({ status: "failed", detail: error.message, ...(error.fix ? { fix: error.fix } : {}) });
    throw error;
  } finally {
    release();
  }
}
