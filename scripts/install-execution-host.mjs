#!/usr/bin/env node
import { isMainModule } from "./is-main-module.mjs";
import fs from "node:fs/promises";
import {
  createPublicationBinding,
  publicationBindingPath,
  readPublicationBinding,
  readLiveState,
  retainPublicationSource,
  verifyPublicationSource,
} from "./instance-web-artifact.mjs";
import { parseArgs } from "node:util";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  realpathSync,
  renameSync,
  chmodSync,
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  SYSTEM_SETTINGS_PATH,
  containerCheckoutPath,
  writeSystemSource,
  mergeSystemSource,
} from "./lib/system-source.mjs";
import {
  PROJECTS_FOLDER_SETTINGS_PATH,
  containerPathsOfFolder,
  isInsideFolder,
  mergeProjectsFolderSettings,
  mountsFolderAtIdenticalPath,
  projectsFolderAliasCommands,
  writeProjectsFolderSettings,
} from "./lib/projects-folder.mjs";
import {
  applyWorktreeLinkChanges,
  formatWorktreeLinkReport,
  scanWorktreeLinks,
} from "./lib/worktree-links.mjs";
import {
  assertProjectsFolderSeparate,
  assertProtectedPaths,
  privateWrite,
  run,
  shellQuote,
  writableBindRoots,
  writeJson as json,
} from "./installer/primitives.mjs";
import { HOST_EXIT_TIMEOUT_SECONDS, createLaunchdManager } from "./installer/launchd.mjs";
import {
  AGENT_SCRIPT,
  COORDINATOR_ENTRYPOINT,
  INSTALLATION_SKILL,
  SUPERVISOR_ENTRYPOINT,
  WEB_DIST,
  assertUnusedServePorts,
  buildRelease,
  hostDaemonConfig,
  installGuestClient,
  loadServerModules,
  pairContainerOrigin,
  renderSkill,
  waitForInstallation,
} from "./installer/host-installation.mjs";

// Kept as a re-export: earlier callers and tests import it from this script.
export { assertProtectedPaths };

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(scriptPath), "..");

function assertOptionalAbsolutePath(value, label) {
  if (value === undefined) return;
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw new Error(`${label} must be an absolute path`);
}

export function validateInstallPlan(input) {
  if (!input || typeof input !== "object") throw new Error("Installation plan must be an object");
  for (const key of [
    "root",
    "revision",
    "containerName",
    "containerServerId",
    "containerPasswordFile",
    "containerDaemonHome",
    "containerOrigin",
  ]) {
    if (typeof input[key] !== "string" || !input[key])
      throw new Error(`Missing installation plan field: ${key}`);
  }
  if (!/^[a-f0-9]{40}$/.test(input.revision))
    throw new Error("Use the full reviewed Git commit SHA");
  assertOptionalAbsolutePath(input.projectsFolder, "The Projects folder");
  const origin = new URL(input.containerOrigin);
  if (origin.protocol !== "https:" || origin.origin !== input.containerOrigin)
    throw new Error("Container origin must be an HTTPS origin");
  const plan = {
    ...input,
    root: path.resolve(input.root),
    coordinatorPort: input.coordinatorPort ?? 6770,
    hostPort: input.hostPort ?? 6771,
    containerPort: input.containerPort ?? 6768,
    httpsPort: input.httpsPort ?? 44444,
    hostHttpsPort: input.hostHttpsPort ?? 44445,
    docker: input.docker ?? "docker",
    tailscale: input.tailscale ?? "tailscale",
    containerUser: input.containerUser ?? "paseo",
    containerCli: input.containerCli ?? "paseo",
  };
  const ports = [
    plan.coordinatorPort,
    plan.hostPort,
    plan.containerPort,
    plan.httpsPort,
    plan.hostHttpsPort,
  ];
  if (
    ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) ||
    new Set(ports).size !== ports.length
  )
    throw new Error("Use distinct unprivileged ports");
  return plan;
}

async function install(planFile) {
  if (process.platform !== "darwin")
    throw new Error("Run installation on the macOS host using the continuity workflow");
  const plan = validateInstallPlan(JSON.parse(readFileSync(planFile, "utf8")));
  const recordFile = path.join(plan.root, "installation.json");
  if (existsSync(recordFile))
    throw new Error(
      "Installation already exists; inspect it with status. Do not overwrite its identity or credentials.",
    );
  if (existsSync(plan.root) && readdirSync(plan.root).length > 0) {
    throw new Error(
      "Installation root must be empty. Preserve existing files and choose a new protected directory.",
    );
  }
  const installationId = randomUUID();
  const name = `local.vorteo.${installationId}`;
  const uid = process.getuid();
  const launchd = createLaunchdManager({ run, uid, home: os.homedir() });
  const hostPlist = launchd.file(`${name}.host`);
  const coordinatorPlist = launchd.file(`${name}.installation`);
  const mountRoots = await writableBindRoots(plan.docker);
  assertProtectedPaths([plan.root, hostPlist, coordinatorPlist, process.execPath], mountRoots);
  mkdirSync(plan.root, { recursive: true, mode: 0o700 });
  chmodSync(plan.root, 0o700);

  const tailnet = JSON.parse(await run(plan.tailscale, ["status", "--json"]));
  const hostname = tailnet.Self?.DNSName?.replace(/\.$/, "");
  if (!hostname || tailnet.BackendState !== "Running")
    throw new Error("Existing host Tailscale must be authenticated and running");
  const serve = JSON.parse(await run(plan.tailscale, ["serve", "status", "--json"]));
  assertUnusedServePorts(serve, hostname, [plan.httpsPort, plan.hostHttpsPort]);
  const origin = `https://${hostname}:${plan.httpsPort}`;
  const hostOrigin = `https://${hostname}:${plan.hostHttpsPort}`;
  const release = path.join(plan.root, "releases", plan.revision);
  const logDir = path.join(plan.root, "logs");
  await buildRelease({ release, revision: plan.revision, sourceDirectory: sourceRoot, logDir });

  const { hashDaemonPassword, getOrCreateServerId, connectInstallationDaemon } =
    await loadServerModules(release);
  const hostHome = path.join(plan.root, "state/host");
  mkdirSync(hostHome, { recursive: true, mode: 0o700 });
  const hostId = getOrCreateServerId(hostHome, { env: {} });
  const ownerPassword = randomBytes(32).toString("base64url");
  const hostPassword = randomBytes(32).toString("base64url");
  const hostToken = randomBytes(32).toString("base64url");
  const containerToken = randomBytes(32).toString("base64url");
  const containerPassword = readFileSync(plan.containerPasswordFile, "utf8").trim();
  if (!containerPassword) throw new Error("Container password file is empty");
  const publicConfig = {
    version: 1,
    installationId,
    origin,
    environments: [
      {
        kind: "container",
        serverId: plan.containerServerId,
        endpoint: new URL(plan.containerOrigin).host,
        useTls: true,
      },
      {
        kind: "host",
        serverId: hostId,
        endpoint: new URL(hostOrigin).host,
        useTls: true,
      },
    ],
  };
  const config = {
    public: publicConfig,
    listenPort: plan.coordinatorPort,
    webDistDir: path.join(release, WEB_DIST),
    stateDir: path.join(plan.root, "state/coordinator"),
    ownerPasswordFile: path.join(plan.root, "owner-password"),
    ownerPasswordHash: hashDaemonPassword(ownerPassword),
    hostAgentTokenHash: createHash("sha256").update(hostToken).digest("hex"),
    containerAgentTokenHash: createHash("sha256").update(containerToken).digest("hex"),
    host: {
      endpoint: `127.0.0.1:${plan.hostPort}`,
      password: hostPassword,
      launchdService: launchd.service(`${name}.host`),
      startupValidation: {
        node: process.execPath,
        entrypoint: path.join(release, SUPERVISOR_ENTRYPOINT),
        home: hostHome,
      },
    },
    container: {
      endpoint: `127.0.0.1:${plan.containerPort}`,
      password: containerPassword,
    },
  };
  await pairContainerOrigin({
    config,
    connectInstallationDaemon,
    docker: plan.docker,
    containerName: plan.containerName,
    containerUser: plan.containerUser,
    containerCli: plan.containerCli,
    containerDaemonHome: plan.containerDaemonHome,
    containerServerId: plan.containerServerId,
    origin,
    root: plan.root,
  });
  const configFile = path.join(plan.root, "coordinator.json");
  json(configFile, config);
  privateWrite(path.join(plan.root, "owner-password"), ownerPassword + "\n");
  const hostClientFile = path.join(plan.root, "host-agent.json");
  json(hostClientFile, {
    origin: `http://127.0.0.1:${plan.coordinatorPort}`,
    publicOrigin: origin,
    token: hostToken,
    kind: "host-agent",
  });
  const agentScript = path.join(release, AGENT_SCRIPT);
  const skillFile = path.join(plan.root, "skills/installation-maintenance/SKILL.md");
  privateWrite(
    skillFile,
    renderSkill(
      readFileSync(path.join(release, INSTALLATION_SKILL), "utf8"),
      origin,
      `${shellQuote(process.execPath)} ${shellQuote(agentScript)} --config ${shellQuote(
        hostClientFile,
      )}`,
    ),
  );
  json(
    path.join(hostHome, "config.json"),
    hostDaemonConfig({
      hostPort: plan.hostPort,
      hostnames: [hostname],
      passwordHash: hashDaemonPassword(hostPassword),
      origins: [origin],
      skillFile,
    }),
  );
  // The System project branches new workspaces from the checkout this install came from.
  writeSystemSource({
    paseoHome: hostHome,
    checkout: sourceRoot,
    ref: plan.revision,
  });
  // New Host projects and worktrees go in the installation's Projects folder.
  if (plan.projectsFolder) {
    assertProjectsFolderSeparate(plan.projectsFolder, [plan.root, hostHome, sourceRoot]);
    writeProjectsFolderSettings({
      paseoHome: hostHome,
      root: plan.projectsFolder,
    });
  }
  const env = {
    HOME: os.homedir(),
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    PASEO_HOME: hostHome,
    VORTEO_INSTALLATION_CLIENT_CONFIG: hostClientFile,
  };
  launchd.write({
    label: `${name}.host`,
    argv: [process.execPath, path.join(release, SUPERVISOR_ENTRYPOINT)],
    env,
    log: path.join(logDir, "host.log"),
    exitTimeout: HOST_EXIT_TIMEOUT_SECONDS,
  });
  launchd.write({
    label: `${name}.installation`,
    argv: [process.execPath, path.join(release, COORDINATOR_ENTRYPOINT), configFile],
    env,
    log: path.join(logDir, "installation.log"),
  });
  const record = {
    version: 1,
    installationId,
    revision: plan.revision,
    root: plan.root,
    release,
    origin,
    hostOrigin,
    configFile,
    hostHome,
    hostPlist,
    coordinatorPlist,
    hostService: config.host.launchdService,
    coordinatorService: launchd.service(`${name}.installation`),
    plan: {
      docker: plan.docker,
      tailscale: plan.tailscale,
      httpsPort: plan.httpsPort,
      hostHttpsPort: plan.hostHttpsPort,
    },
    phase: "prepared",
  };
  json(recordFile, record);
  // Installation ownership is recorded before starting anything. Failed setup remains inspectable.
  await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, hostPlist]);
  await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, coordinatorPlist]);
  const liveServe = JSON.parse(await run(plan.tailscale, ["serve", "status", "--json"]));
  assertUnusedServePorts(liveServe, hostname, [plan.httpsPort, plan.hostHttpsPort]);
  await waitForInstallation(config, connectInstallationDaemon);
  await run(plan.tailscale, [
    "serve",
    "--bg",
    `--https=${plan.httpsPort}`,
    `http://127.0.0.1:${plan.coordinatorPort}`,
  ]);
  await run(plan.tailscale, [
    "serve",
    "--bg",
    `--https=${plan.hostHttpsPort}`,
    `http://127.0.0.1:${plan.hostPort}`,
  ]);
  await installGuestClient({
    docker: plan.docker,
    containerName: plan.containerName,
    containerUser: plan.containerUser,
    origin,
    token: containerToken,
    root: plan.root,
    release,
  });
  json(recordFile, { ...record, phase: "started" });
  process.stdout.write(
    `Installation started: ${origin}\nOwner password file: ${path.join(
      plan.root,
      "owner-password",
    )}\nRun status and complete host/phone acceptance before claiming delivery.\n`,
  );
}

async function installationStatus(record) {
  const launchd = {};
  for (const [kind, service] of [
    ["host", record.hostService],
    ["installation", record.coordinatorService],
  ]) {
    try {
      await run("/bin/launchctl", ["print", service]);
      launchd[kind] = "registered";
    } catch {
      launchd[kind] = "not registered";
    }
  }
  const config = JSON.parse(readFileSync(record.configFile, "utf8"));
  const { connectInstallationDaemon } = await import(
    pathToFileURL(
      path.join(
        record.release,
        "packages/server/dist/server/server/execution-installation/daemon.js",
      ),
    )
  );
  const readiness = {};
  for (const kind of ["host", "container"]) {
    let client;
    try {
      client = await connectInstallationDaemon(config, kind);
      const status = await client.getDaemonStatus({ timeout: 3000 });
      readiness[kind] = { ready: true, pid: status.pid };
    } catch {
      readiness[kind] = { ready: false };
    } finally {
      await client?.close();
    }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.listenPort}/api/installation/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json();
    readiness.installation = {
      ready: response.ok && body.installationId === record.installationId,
    };
  } catch {
    readiness.installation = { ready: false };
  }
  process.stdout.write(
    JSON.stringify(
      {
        installationId: record.installationId,
        origin: record.origin,
        revision: record.revision,
        launchd,
        readiness,
      },
      null,
      2,
    ) + "\n",
  );
}

export function assertContainerProfileLauncher({ expected, supervisor, worker }) {
  if (supervisor !== expected || worker !== expected) {
    throw new Error(
      "The Dev supervisor and worker must inherit VORTEO_INSTALLATION_CLIENT_CONFIG from the owned launcher before bootstrap. Repair the launcher and obtain approval for a supervisor restart.",
    );
  }
}

/** Bind static publication to the existing protected source configuration; no activation. */
export async function configureWebSource(planFile) {
  const input = JSON.parse(readFileSync(planFile, "utf8"));
  if (!path.isAbsolute(input.configFile) || !path.isAbsolute(input.docker))
    throw new Error("Use absolute protected config and trusted Host Docker executable paths");
  const configFile = await fs.realpath(input.configFile);
  const original = await fs.readFile(configFile, "utf8");
  const config = JSON.parse(original);
  const settings = config.sourceUpdates;
  if (!settings)
    throw new Error("Host source updates must have a prepared protected configuration");
  const binding = await createPublicationBinding({
    destination: settings.webDirectory,
    sourceRepository: settings.sourceRepository,
    integrationRef: settings.integrationRef,
  });
  if ((await fs.realpath(config.webDistDir)) !== binding.webDirectory)
    throw new Error("Configured interface and source update publication directories disagree");
  const bindingFile = publicationBindingPath(binding.webDirectory);
  const parent = path.dirname(bindingFile);
  const mountRoots = await writableBindRoots(input.docker);
  assertProtectedPaths(
    [
      configFile,
      binding.webDirectory,
      parent,
      binding.sourceRepository,
      binding.gitDirectory,
      binding.commonDirectory,
    ],
    mountRoots,
  );
  for (const file of [configFile, parent]) {
    const stat = await fs.stat(file);
    if (stat.mode & 0o022 || stat.uid !== process.getuid())
      throw new Error("Publication config and binding parent must be protected and Host-owned");
  }
  const lock = path.join(binding.webDirectory, ".publish-lock");
  await fs.mkdir(lock); // Share the publisher lock, including during first binding.
  const temporary = `${bindingFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
        operation: "bind-source",
      }),
    );
    const previous = await readPublicationBinding(binding.webDirectory);
    if (previous && Object.keys(binding).some((key) => previous[key] !== binding[key]))
      throw new Error("Conflicting protected publication binding; explicit migration required");
    const live = await readLiveState(binding.webDirectory);
    if (!live.release?.sourceCommit || live.release.integrationRef !== binding.integrationRef)
      throw new Error("Adopt and verify the current interface source before binding publication");
    await verifyPublicationSource({
      repository: input.repository,
      sourceCommit: live.release.sourceCommit,
      requireComplete: true,
    });
    await retainPublicationSource({
      binding,
      repository: input.repository,
      sourceCommit: live.release.sourceCommit,
    });
    if ((await fs.readFile(configFile, "utf8")) !== original)
      throw new Error("Protected source configuration changed during publication setup");
    if (!previous) {
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(binding, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.link(temporary, bindingFile); // Add only; never overwrite an existing binding.
    }
    // Matching retries also reconcile uncertain persistence after an earlier link or sync failure.
    const directory = await fs.open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { bindingFile, sourceCommit: live.release.sourceCommit };
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}

// Runs inside the Dev container as its daemon user, so the file keeps that owner.
const CONTAINER_SYSTEM_SETTINGS_SCRIPT = `import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
const [home, relative, mode, text] = process.argv.slice(1);
const file = path.join(home, relative);
if (mode === 'read') process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
else {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}`;

/**
 * Records the Host checkout, as the Dev container sees it, in the Dev daemon's System
 * settings. Skips, with a reason, when no bind mount shares the checkout.
 */
export async function writeContainerSystemSource(settings, checkout) {
  const [container] = JSON.parse(await run(settings.docker, ["inspect", settings.containerId]));
  const target = containerCheckoutPath(container?.Mounts, checkout);
  if (!target)
    return {
      written: false,
      reason: `The Dev container cannot see ${checkout}, so its System project keeps its own folder. Share the checkout with the container and run configure-system-source.`,
    };
  const exec = (mode, text = "") =>
    run(settings.docker, [
      "exec",
      "--user",
      settings.user,
      settings.containerId,
      settings.node,
      "--input-type=module",
      "--eval",
      CONTAINER_SYSTEM_SETTINGS_SCRIPT,
      settings.home,
      SYSTEM_SETTINGS_PATH,
      mode,
      text,
    ]);
  const existing = await exec("read");
  const next = mergeSystemSource(existing, { checkout: target });
  if (next.trim() !== existing.trim()) await exec("write", next);
  return { written: true, checkout: target };
}

/**
 * Points both System projects at the checkout this installer runs from, or `checkout`.
 * For installations made before installers wrote the setting, and after a checkout moves.
 * Takes effect at each daemon's next start.
 */
export async function configureSystemSource(root, checkout = sourceRoot) {
  const record = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const resolved = realpathSync(path.resolve(checkout));
  if (!existsSync(path.join(resolved, ".git")))
    throw new Error(`${resolved} is not a git checkout`);
  const host = writeSystemSource({
    paseoHome: record.hostHome,
    checkout: resolved,
  });
  const config = JSON.parse(readFileSync(record.configFile, "utf8"));
  const dev = config.containerSourceUpdates
    ? await writeContainerSystemSource(config.containerSourceUpdates, resolved)
    : { written: false, reason: "No Dev container is configured for updates." };
  return { checkout: resolved, host, dev };
}

/** Adds the folder to git's trusted directories for the Dev daemon user, once. */
async function trustProjectsFolderInContainer(settings, folder, previousPaths) {
  const git = (...args) =>
    run(settings.docker, [
      "exec",
      "--user",
      settings.user,
      settings.containerId,
      "git",
      "config",
      "--global",
      ...args,
    ]);
  // Exit status 1 means no entries yet.
  const existing = (await git("--get-all", "safe.directory").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  // Git 2.46 and later read the trailing /* as every folder below; earlier entries keep
  // their own paths, moved to the identical-path folder. Git reports a checkout reached
  // through an alias by its real path, so an alias is trusted too.
  const wanted = [`${folder}/*`];
  for (const entry of existing) {
    for (const previous of previousPaths) {
      if (entry === previous || entry.startsWith(`${previous}/`))
        wanted.push(path.posix.join(folder, entry.slice(previous.length)));
    }
  }
  const added = [...new Set(wanted)].filter((entry) => !existing.includes(entry));
  for (const entry of added) await git("--add", "safe.directory", entry);
  return added;
}

// Reads only: prints the container's real path for each argument, or "" when it is missing.
const CONTAINER_REALPATH_SCRIPT = `import fs from 'node:fs';
const real = (value) => { try { return fs.realpathSync(value); } catch { return ''; } };
process.stdout.write(JSON.stringify(process.argv.slice(1).map(real)));`;

/**
 * How the Dev container sees the host folder at its own path: an identical bind mount, or
 * a symlink at that path to the folder's mount, which the daemon records as an alias.
 * Inspects only; it never creates the symlink.
 */
async function resolveContainerProjectsFolder(settings, root) {
  const [container] = JSON.parse(await run(settings.docker, ["inspect", settings.containerId]));
  if (mountsFolderAtIdenticalPath(container?.Mounts, root)) return { aliases: [] };
  const mountPaths = containerPathsOfFolder(container?.Mounts, root);
  if (mountPaths.length === 0)
    return {
      refusal: {
        reason: `The Dev container does not mount ${root}. Recreate it with that folder bind-mounted at the same path, then run configure-projects-folder again.`,
      },
    };
  const [folderReal, ...mountReals] = JSON.parse(
    await run(settings.docker, [
      "exec",
      "--user",
      settings.user,
      settings.containerId,
      settings.node,
      "--input-type=module",
      "--eval",
      CONTAINER_REALPATH_SCRIPT,
      root,
      ...mountPaths,
    ]),
  );
  const alias = mountPaths.find(
    (mountPath, index) => folderReal && folderReal === mountReals[index],
  );
  if (alias) return { aliases: [alias] };
  const commands = projectsFolderAliasCommands(root, mountPaths[0]);
  return {
    refusal: {
      reason: `The Dev container mounts ${root} at ${mountPaths[0]} and has no symlink at ${root}. Run the root command once in the container, check it with the verify command as the daemon user, then run configure-projects-folder again.`,
      commands: {
        root: commands.root,
        verify: commands.verify,
        dockerRoot: `${shellQuote(settings.docker)} exec --user root ${shellQuote(
          settings.containerId,
        )} sh -c ${shellQuote(commands.root)}`,
        dockerVerify: `${shellQuote(settings.docker)} exec --user ${shellQuote(
          settings.user,
        )} ${shellQuote(settings.containerId)} sh -c ${shellQuote(commands.verify)}`,
      },
    },
  };
}

async function writeContainerProjectsFolder(settings, input) {
  const access = await resolveContainerProjectsFolder(settings, input.root);
  if (access.refusal) return { written: false, ...access.refusal };
  const aliases = [...input.aliases, ...access.aliases];
  const exec = (mode, text = "") =>
    run(settings.docker, [
      "exec",
      "--user",
      settings.user,
      settings.containerId,
      settings.node,
      "--input-type=module",
      "--eval",
      CONTAINER_SYSTEM_SETTINGS_SCRIPT,
      settings.home,
      PROJECTS_FOLDER_SETTINGS_PATH,
      mode,
      text,
    ]);
  const existing = await exec("read");
  const next = mergeProjectsFolderSettings(existing, { ...input, aliases });
  if (next.trim() !== existing.trim()) await exec("write", next);
  const trusted = await trustProjectsFolderInContainer(settings, input.root, [
    ...input.migrateFrom,
    ...aliases,
  ]);
  return { written: true, root: input.root, aliases: access.aliases, trusted };
}

/**
 * Records the Projects folder for the Host and the Dev daemon. `migrateFrom` and `aliases`
 * list other container paths of the same folder; the Dev daemon records paths under them
 * by the folder's own path and moves registry paths from them at its next start. An
 * existing container may reach the folder's path through a symlink to its older mount,
 * which is found and recorded as an alias. The Host records the same lists. Takes effect at
 * each daemon's next start.
 */
export async function configureProjectsFolder(
  root,
  { folder, migrateFrom = [], aliases = [], allowOutside = [], keepPaths = [] },
) {
  if (!folder || !path.isAbsolute(folder)) throw new Error("Use --folder with an absolute path");
  const record = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const resolved = realpathSync(folder);
  if (!statSync(resolved).isDirectory()) throw new Error(`${resolved} is not a folder`);
  assertProjectsFolderSeparate(resolved, [root, record.hostHome, record.release, sourceRoot]);
  // The Host records the same earlier paths, aliases and kept paths as Dev, because it is
  // the same folder: keys that Dev recorded under an alias, such as shared sidebar state,
  // then map to the logical root on the Host too. The Host has no paths under them, so
  // nothing else it records changes.
  const writeHost = (detectedAliases = []) =>
    writeProjectsFolderSettings({
      paseoHome: record.hostHome,
      root: resolved,
      migrateFrom,
      aliases: [...aliases, ...detectedAliases],
      allowOutside,
      keepPaths,
    });
  let host = writeHost();
  const config = JSON.parse(readFileSync(record.configFile, "utf8"));
  const dev = config.containerSourceUpdates
    ? await writeContainerProjectsFolder(config.containerSourceUpdates, {
        root: resolved,
        migrateFrom,
        aliases,
        allowOutside,
        keepPaths,
      })
    : { written: false, reason: "No Dev container is configured for updates." };
  if (dev.aliases?.length) {
    const withDetected = writeHost(dev.aliases);
    host = { ...withDetected, changed: host.changed || withDetected.changed };
  }
  return { folder: resolved, host, dev };
}

/** The Host's Projects folder settings, or none without an installation root. */
function readHostProjectsFolderSettings(root) {
  if (!root) return {};
  const record = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const file = path.join(record.hostHome, PROJECTS_FOLDER_SETTINGS_PATH);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function resolveRepairFolder(folder) {
  if (!folder || !path.isAbsolute(folder))
    throw new Error(
      "Use --folder with an absolute path, or --root with a configured Projects folder",
    );
  if (!statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder`);
  return folder;
}

function resolveRepairPrefixes(prefixes, folder) {
  if (prefixes.length === 0)
    throw new Error("Use --from <old prefix>, or --root with configured aliases");
  for (const prefix of prefixes) {
    if (!path.isAbsolute(prefix)) throw new Error("--from must be an absolute path");
    if (isInsideFolder(prefix, folder) || isInsideFolder(folder, prefix))
      throw new Error(`${prefix} overlaps the Projects folder ${folder}`);
  }
  return prefixes;
}

/**
 * Rewrites worktree links that Dev recorded under an old container path to the Projects
 * folder's logical path, so the Host no longer lists those worktrees as prunable. A dry run
 * unless `apply` is set. With `root`, the Host's projects-folder.json supplies the folder,
 * the old prefixes (`migrateFrom` and `aliases`) and the kept paths.
 */
export function repairProjectsFolderWorktreeLinks({
  root,
  folder,
  from = [],
  keepPaths = [],
  depth = 4,
  apply = false,
}) {
  const settings = readHostProjectsFolderSettings(root);
  const resolvedFolder = resolveRepairFolder(folder ?? settings.root);
  const prefixes = resolveRepairPrefixes(
    from.length ? from : [...(settings.migrateFrom ?? []), ...(settings.aliases ?? [])],
    resolvedFolder,
  );
  const scan = scanWorktreeLinks({
    folder: resolvedFolder,
    from: prefixes,
    keepPaths: [...new Set([...(settings.keepPaths ?? []), ...keepPaths])],
    depth,
  });
  return {
    scan,
    written: apply ? applyWorktreeLinkChanges(scan.changes) : null,
  };
}

/** Prepare the scoped Dev updater without restarting any service or changing its launcher. */
export async function configureContainerUpdates(planFile) {
  const input = JSON.parse(readFileSync(planFile, "utf8"));
  const configFile = path.resolve(input.configFile);
  const originalConfig = readFileSync(configFile, "utf8");
  const config = JSON.parse(originalConfig);
  const root = path.dirname(configFile);
  const serverDir = path.join(
    sourceRoot,
    "packages/server/dist/server/server/execution-installation",
  );
  const { ContainerSourceUpdatesSchema } = await import(
    pathToFileURL(path.join(serverDir, "config.js"))
  );
  const { connectInstallationDaemon } = await import(
    pathToFileURL(path.join(serverDir, "daemon.js"))
  );
  if (!/^[a-f0-9]{40}$/.test(input.revision))
    throw new Error("Use the verified installed Dev source commit");
  if (!path.isAbsolute(input.docker))
    throw new Error("Use the trusted Host Docker executable's absolute path");
  const containers = JSON.parse(await run(input.docker, ["inspect", input.containerName]));
  if (containers.length !== 1 || !containers[0].State.Running)
    throw new Error("Configured Dev container must be running");
  const settings = ContainerSourceUpdatesSchema.parse({
    sourceRepository: input.sourceRepository,
    integrationRef: input.integrationRef,
    toolingDirectory: path.join(root, "container-update-tools"),
    receiptFile: path.join(config.stateDir, "container-source.json"),
    docker: input.docker,
    containerId: containers[0].Id,
    user: input.user,
    node: input.node,
    home: input.home,
    releaseRoot: input.releaseRoot,
    currentReleaseLink: input.currentReleaseLink,
  });
  assertProtectedPaths(
    [configFile, settings.sourceRepository, settings.toolingDirectory, settings.receiptFile],
    await writableBindRoots(settings.docker),
  );
  const helper = readFileSync(
    path.join(sourceRoot, "scripts/installation-container-runtime.mjs"),
    "utf8",
  );
  const inContainer = async (operation) =>
    JSON.parse(
      await run(settings.docker, [
        "exec",
        "--user",
        settings.user,
        settings.containerId,
        settings.node,
        "--input-type=module",
        "--eval",
        helper,
        JSON.stringify({ ...operation, settings }),
      ]),
    );
  const selected = await inContainer({ action: "inspect" });
  if (selected.sourceCommit !== input.revision)
    throw new Error("Installed Dev release differs from the reviewed bootstrap plan");
  const object = await run("git", ["cat-file", "-t", selected.sourceCommit], {
    cwd: settings.sourceRepository,
  });
  if (object !== "commit")
    throw new Error("Protected source repository lacks the installed Dev commit");
  const client = await connectInstallationDaemon(config, "container");
  try {
    const { pid } = await client.getDaemonStatus({ timeout: 30_000 });
    await inContainer({
      action: "verify",
      pid,
      release: selected.release,
      update: { sourceCommit: selected.sourceCommit },
    });
    const profileLauncher = JSON.parse(
      await run(settings.docker, [
        "exec",
        "--user",
        settings.user,
        settings.containerId,
        settings.node,
        "--input-type=module",
        "--eval",
        `import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
const marker=JSON.parse(fs.readFileSync(path.join(process.argv[1],'managed-supervisor.json'),'utf8'));
const read=pid=>fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0').find(value=>value.startsWith('VORTEO_INSTALLATION_CLIENT_CONFIG='))?.slice('VORTEO_INSTALLATION_CLIENT_CONFIG='.length)??null;
console.log(JSON.stringify({expected:path.join(os.homedir(),'.local/share/vorteo-installation-client/client.json'),supervisor:read(marker.pid),worker:read(process.argv[2])}));`,
        settings.home,
        String(pid),
      ]),
    );
    assertContainerProfileLauncher(profileLauncher);
  } finally {
    await client.close();
  }
  // Finish every check before installing configuration. Preserve exact previous bytes for rollback.
  if (readFileSync(configFile, "utf8") !== originalConfig)
    throw new Error(
      "Installation configuration changed during bootstrap; reconcile before retrying",
    );
  const backup = `${configFile}.${randomUUID()}.before-dev-updates`;
  privateWrite(backup, readFileSync(configFile));
  privateWrite(path.join(settings.toolingDirectory, "installation-container-runtime.mjs"), helper);
  const systemSource = await writeContainerSystemSource(settings, sourceRoot).catch((error) => ({
    written: false,
    reason: `Could not record the source checkout for the Dev System project: ${error.message}`,
  }));
  if (!systemSource.written) process.stderr.write(`${systemSource.reason}\n`);
  json(settings.receiptFile, {
    sourceCommit: selected.sourceCommit,
    release: selected.release,
  });
  json(configFile, { ...config, containerSourceUpdates: settings });
  // Refresh request-only tooling in the already paired guest. Never copy Host credentials.
  const guestHome = await run(settings.docker, [
    "exec",
    "--user",
    settings.user,
    settings.containerId,
    settings.node,
    "-p",
    "require('os').homedir()",
  ]);
  const guestDir = path.join(guestHome, ".local/share/vorteo-installation-client");
  const skill = readFileSync(
    path.join(sourceRoot, "scripts/installation-skills/installation-maintenance/SKILL.md"),
    "utf8",
  )
    .replaceAll(
      "INSTALLATION_SETTINGS_URL",
      `${config.public.origin}/settings/general?installation=1`,
    )
    .replaceAll(
      "INSTALLATION_CLIENT_COMMAND",
      `${shellQuote(settings.node)} ${shellQuote(
        path.join(guestDir, "installation-agent.mjs"),
      )} --config ${shellQuote(path.join(guestDir, "client.json"))}`,
    );
  const guestFiles = [
    [
      path.join(guestDir, "installation-agent.mjs"),
      readFileSync(path.join(sourceRoot, "scripts/installation-agent.mjs"), "utf8"),
    ],
    ...[".agents", ".claude", ".codex"].map((directory) => [
      path.join(guestHome, directory, "skills/installation-maintenance/SKILL.md"),
      skill,
    ]),
  ];
  await run(settings.docker, [
    "exec",
    "--user",
    settings.user,
    settings.containerId,
    settings.node,
    "-e",
    "const fs=require('fs'),path=require('path'); for(const [file,content] of JSON.parse(process.argv[1])) { fs.mkdirSync(path.dirname(file),{recursive:true}); const next=file+'.next'; fs.writeFileSync(next,content,{mode:0o600}); fs.renameSync(next,file); }",
    JSON.stringify(guestFiles),
  ]);
  process.stdout.write(
    JSON.stringify({
      configured: true,
      configFile,
      backup,
      target: "container-daemon",
      coordinatorReloadRequired: true,
      restarted: false,
    }) + "\n",
  );
}

async function stopOwnedServices(record) {
  for (const service of [record.coordinatorService, record.hostService]) {
    let registered = false;
    try {
      await run("/bin/launchctl", ["print", service]);
      registered = true;
    } catch {
      /* absent service is already stopped */
    }
    if (registered) await run("/bin/launchctl", ["bootout", service]);
  }
}

/**
 * The coordinator owns the durable session host's launchd job. Removing the installation first
 * would leave that job running sessions with no daemon to attach them, so removal waits for it.
 */
export async function assertSessionHostJobRemoved(
  record,
  ports = {
    uid: process.getuid(),
    launchAgents: path.join(os.homedir(), "Library", "LaunchAgents"),
    exists: existsSync,
    run,
  },
) {
  const label = `local.vorteo.${record.installationId}.session-host`;
  let loaded = false;
  try {
    await ports.run("/bin/launchctl", ["print", `gui/${ports.uid}/${label}`]);
    loaded = true;
  } catch {
    /* not loaded */
  }
  if (loaded || ports.exists(path.join(ports.launchAgents, `${label}.plist`)))
    throw new Error(
      `Remove the session host job (${label}) from Installation controls before removing this installation.`,
    );
}

function validateLaunchAgentPaths(record) {
  for (const file of [record.hostPlist, record.coordinatorPlist]) {
    const ownedDirectory = path.join(os.homedir(), "Library", "LaunchAgents");
    if (
      path.dirname(file) !== ownedDirectory ||
      !path.basename(file).startsWith(`local.vorteo.${record.installationId}.`)
    )
      throw new Error("LaunchAgent path is not owned by this installation");
  }
}

async function manage(command, root) {
  const record = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  if (command === "status") {
    await installationStatus(record);
    return;
  }
  if (command !== "remove")
    throw new Error("Commands: install --plan <file>, status --root <path>, remove --root <path>");
  const expected = `gui/${process.getuid()}/local.vorteo.${record.installationId}`;
  if (
    record.hostService !== `${expected}.host` ||
    record.coordinatorService !== `${expected}.installation` ||
    path.resolve(root) !== record.root
  ) {
    throw new Error("Installation lifecycle ownership does not match this record");
  }
  const config = JSON.parse(readFileSync(record.configFile, "utf8"));
  const serve = JSON.parse(await run(record.plan.tailscale, ["serve", "status", "--json"]));
  const hostname = new URL(record.origin).hostname;
  const routes = [
    [record.plan.httpsPort, `http://127.0.0.1:${config.listenPort}`],
    [record.plan.hostHttpsPort, `http://${config.host.endpoint}`],
  ];
  for (const [port, target] of routes) {
    const current = serve.Web?.[`${hostname}:${port}`]?.Handlers?.["/"]?.Proxy;
    if (current && current !== target)
      throw new Error(`HTTPS port ${port} now belongs to another target; refusing removal`);
  }
  await assertSessionHostJobRemoved(record);
  validateLaunchAgentPaths(record);
  await stopOwnedServices(record);
  const disabled = path.join(root, "disabled-launch-agents");
  mkdirSync(disabled, { recursive: true, mode: 0o700 });
  for (const file of [record.hostPlist, record.coordinatorPlist]) {
    if (existsSync(file)) renameSync(file, path.join(disabled, path.basename(file)));
  }
  for (const [port] of routes) {
    if (serve.Web?.[`${hostname}:${port}`])
      await run(record.plan.tailscale, ["serve", `--https=${port}`, "off"]);
  }
  // Retain state, credentials, release and receipt for recovery. Existing container is attach-only.
  json(path.join(root, "installation.json"), { ...record, phase: "stopped" });
  process.stdout.write(
    "Stopped only this installation's new host services and HTTPS routes. State and the existing container were preserved.\n",
  );
}

if (isMainModule(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      plan: { type: "string" },
      root: { type: "string" },
      checkout: { type: "string" },
      folder: { type: "string" },
      "migrate-from": { type: "string", multiple: true },
      alias: { type: "string", multiple: true },
      "allow-outside": { type: "string", multiple: true },
      "keep-path": { type: "string", multiple: true },
      from: { type: "string", multiple: true },
      depth: { type: "string" },
      apply: { type: "boolean" },
    },
  });
  if (positionals[0] === "install" && values.plan) await install(values.plan);
  else if (positionals[0] === "configure-web-source" && values.plan)
    process.stdout.write(JSON.stringify(await configureWebSource(values.plan)) + "\n");
  else if (positionals[0] === "configure-dev-updates" && values.plan)
    await configureContainerUpdates(values.plan);
  else if (positionals[0] === "configure-system-source" && values.root)
    process.stdout.write(
      JSON.stringify(await configureSystemSource(values.root, values.checkout), null, 2) + "\n",
    );
  else if (positionals[0] === "configure-projects-folder" && values.root)
    process.stdout.write(
      JSON.stringify(
        await configureProjectsFolder(values.root, {
          folder: values.folder,
          migrateFrom: values["migrate-from"],
          aliases: values.alias,
          allowOutside: values["allow-outside"],
          keepPaths: values["keep-path"],
        }),
        null,
        2,
      ) + "\n",
    );
  else if (
    positionals[0] === "repair-projects-folder-worktree-links" &&
    (values.root || values.folder)
  )
    process.stdout.write(
      formatWorktreeLinkReport(
        repairProjectsFolderWorktreeLinks({
          root: values.root,
          folder: values.folder,
          from: values.from,
          keepPaths: values["keep-path"],
          depth: values.depth === undefined ? undefined : Number.parseInt(values.depth, 10),
          apply: values.apply === true,
        }),
      ),
    );
  else if (values.root) await manage(positionals[0], values.root);
  else
    throw new Error(
      "Use install/configure-dev-updates/configure-web-source --plan <private-plan.json>, configure-system-source --root <installation-root> [--checkout <path>], configure-projects-folder --root <installation-root> --folder <path> [--migrate-from <old container path>] [--alias <container path>] [--allow-outside <path>] [--keep-path <exact recorded path>], repair-projects-folder-worktree-links --folder <path> --from <old prefix> [--root <installation-root>] [--keep-path <repository root>] [--depth <n>] [--apply], or status/remove --root <installation-root>",
    );
}
