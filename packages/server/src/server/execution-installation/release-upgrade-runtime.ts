import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import {
  SnapshotPartKindSchema,
  SnapshotRestoreStatusSchema,
  type InstallationUpgrade,
  type SnapshotList,
  type SnapshotRestoreRequest,
  type SnapshotRestoreStatus,
  type UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";
import type { RestartJob, SourceUpdate } from "@getpaseo/protocol/execution-installation";
import { writePrivateFileAtomicSync } from "../private-files.js";
import type { InstallationConfig } from "./config.js";
import { connectInstallationDaemon } from "./daemon.js";
import {
  launchHandoff,
  readCurrentLink,
  readHandoffOutcome,
  type CoordinatorSwapPlan,
  type RestorePlan,
} from "./coordinator-handoff.js";
import {
  createUpgradeJournal,
  InstallationUpgrades,
  type AdoptionOutcome,
  type UpgradePorts,
} from "./release-upgrades.js";
import { VORTEO_RELEASE_GIT_URL, VORTEO_RELEASE_REPOSITORY } from "./release-source.js";
import { RestartRequestError, type InstallationRestarts } from "./restarts.js";
import { managedServices, runCommand, type CommandRunner } from "./service-control.js";
import {
  createInstallationSnapshots,
  dockerSnapshotPorts,
  snapshotPartKinds,
  snapshotRoot,
  snapshotSources,
  type InstallationSnapshots,
} from "./snapshots.js";
import type { InstallationSourceUpdates } from "./source-updates.js";

const COORDINATOR_READY_TIMEOUT_MS = 120_000;
const UPGRADE_REASON_PREFIX = "Release upgrade";
// Adoption may build the Dev and gate images and a release before it restarts anything.
const ADOPTION_DEADLINE_MS = 4 * 60 * 60_000;
const INSTALLER_ENGINE = "scripts/installer/main.mjs";
const SUPERVISOR_ENTRYPOINT = "packages/server/dist/scripts/supervisor-entrypoint.js";
const COMMIT = /^[a-f0-9]{40}$/;

export interface ReleaseUpgradeRuntime {
  upgrades: InstallationUpgrades | null;
  /**
   * After a Host source update this process saw succeed, moves an installation from before
   * the installer to its layout, once. Upgrades from the interface do the same first.
   */
  adoptAfterSourceUpdate(): void;
  snapshots: InstallationSnapshots | null;
  snapshotList(): SnapshotList;
  takeSnapshot(): ReturnType<InstallationSnapshots["take"]>;
  restore(request: SnapshotRestoreRequest): Promise<SnapshotRestoreStatus>;
  upgradeStatus(): UpgradeStatus;
}

/** The release root a coordinator entrypoint runs from. */
export function releaseOfEntrypoint(entrypoint: string): string {
  const suffix = path.join("packages/server/dist/server/server/execution-installation");
  const directory = path.dirname(realpathSync(entrypoint));
  if (!directory.endsWith(suffix)) throw new Error("The coordinator does not run from a release");
  return directory.slice(0, -suffix.length - 1);
}

function readEnvImage(directory: string): string {
  const line = readFileSync(path.join(directory, ".env"), "utf8")
    .split("\n")
    .find((item) => item.startsWith("PASEO_IMAGE="));
  if (!line) throw new Error("Dev's deployment has no PASEO_IMAGE");
  return line.slice("PASEO_IMAGE=".length).trim();
}

/**
 * True for a Host installation made before the one-command installer: its configuration
 * has no `deployment` and sits beside the old installer's installation.json. Upgrades
 * move it to the installer layout first, through the engine's `adopt` command.
 */
export function adoptionRequired(config: InstallationConfig, configFile: string): boolean {
  return !config.deployment && existsSync(path.join(path.dirname(configFile), "installation.json"));
}

/** Why upgrades cannot run on this installation, or null. */
export function upgradeBlocker(config: InstallationConfig, adoptable = false): string | null {
  // Adoption writes the deployment block, the release links and the service descriptors.
  if (!config.deployment && adoptable) return null;
  if (!config.deployment) return "Upgrades need an installation made by the one-command installer.";
  // An installer-made installation upgrades its Host through the engine and its link.
  if (!directHostUpgrades(config) && (!config.sourceUpdates || !config.host.startupValidation))
    return "Upgrades need Host source updates, which this installation has not configured.";
  const services = managedServices(config);
  if (typeof services === "string") return services;
  return null;
}

/** True when the installer engine, not Host source updates, builds Host releases. */
function directHostUpgrades(config: InstallationConfig): boolean {
  return !config.sourceUpdates && Boolean(config.deployment?.hostReleaseLink);
}

const DIRECT_JOB_PREFIX = "installer-";

/** The revision the installer engine built into a release, from its marker file. */
function installerRevision(release: string): string | null {
  try {
    const marker = JSON.parse(readFileSync(path.join(release, ".installer-release.json"), "utf8"));
    return typeof marker.revision === "string" && COMMIT.test(marker.revision)
      ? marker.revision
      : null;
  } catch {
    return null;
  }
}

/**
 * The Host commit of an installation from before the installer: its release folder,
 * which scripts/install-execution-host.mjs names by commit, or a source receipt in it.
 */
export function legacyHostCommit(config: InstallationConfig): string | null {
  const entrypoint = config.host.startupValidation?.entrypoint;
  if (!entrypoint) return null;
  try {
    const file = realpathSync(entrypoint);
    if (!file.endsWith(`/${SUPERVISOR_ENTRYPOINT}`)) return null;
    const release = file.slice(0, -SUPERVISOR_ENTRYPOINT.length - 1);
    const marked = installerRevision(release);
    if (marked) return marked;
    const receiptFile = path.join(release, ".installation-source.json");
    if (existsSync(receiptFile)) {
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      if (COMMIT.test(receipt.sourceCommit ?? "")) return receipt.sourceCommit;
    }
    return COMMIT.test(path.basename(release)) ? path.basename(release) : null;
  } catch {
    return null;
  }
}

/** Starts `node args` in its own session with output in `log`, so it outlives this process. */
function spawnDetached(node: string, args: string[], log: string): void {
  const descriptor = openSync(log, "a", 0o600);
  try {
    spawn(node, args, { detached: true, stdio: ["ignore", descriptor, descriptor] }).unref();
  } finally {
    closeSync(descriptor);
  }
}

function readAdoptionOutcome(file: string): AdoptionOutcome | null {
  try {
    const result = JSON.parse(readFileSync(file, "utf8"));
    if (result.status !== "succeeded" && result.status !== "failed") return null;
    return { status: result.status, detail: String(result.detail ?? "") };
  } catch {
    return null;
  }
}

export function createReleaseUpgradeRuntime(input: {
  config: InstallationConfig;
  configFile: string;
  restarts: InstallationRestarts;
  hostUpdates: InstallationSourceUpdates | null;
  logger: Logger;
  run?: CommandRunner;
  entrypoint?: string;
}): ReleaseUpgradeRuntime {
  const { config, configFile, restarts, hostUpdates, logger } = input;
  const run = input.run ?? runCommand;
  const entrypoint = input.entrypoint ?? process.argv[1] ?? "";
  const root = snapshotRoot(config);
  const snapshots = root
    ? createInstallationSnapshots({
        root,
        sources: () => snapshotSources(config, configFile),
        ports: { now: () => new Date(), ...dockerSnapshotPorts },
      })
    : null;
  const upgradeDirectory = path.join(config.stateDir, "upgrades");
  const restoreDirectory = root ? path.join(root, ".restores") : null;
  const services = managedServices(config);
  const adoptable = adoptionRequired(config, configFile);
  const blocker = upgradeBlocker(config, adoptable);
  const health = {
    url: `http://127.0.0.1:${config.listenPort}/api/installation/health`,
    installationId: config.public.installationId,
    previousPid: process.pid,
  };
  const hostNode = config.host.startupValidation?.node ?? process.execPath;
  const helper = () =>
    path.join(path.dirname(realpathSync(entrypoint)), "coordinator-handoff-main.js");

  function currentCommit(): string | null {
    const link = config.deployment?.hostReleaseLink;
    if (directHostUpgrades(config) && link) {
      try {
        return installerRevision(realpathSync(link));
      } catch {
        return null;
      }
    }
    try {
      const base = hostUpdates?.source().baseCommit;
      if (base) return base;
    } catch {
      /* Host source updates are unconfigured or unreadable */
    }
    return config.deployment ? null : legacyHostCommit(config);
  }

  const directOutcome = (upgradeId: string) =>
    path.join(upgradeDirectory, upgradeId, "host-release.json");

  /** Starts the engine's Host release build detached, so it survives this coordinator. */
  function launchDirectHostRelease(upgrade: InstallationUpgrade): string {
    const deployment = config.deployment;
    if (!deployment) throw new Error("The installation deployment is unknown");
    const directory = path.join(upgradeDirectory, upgrade.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const outcome = directOutcome(upgrade.id);
    if (!existsSync(outcome))
      spawnDetached(
        hostNode,
        [
          path.join(deployment.sourceDirectory, INSTALLER_ENGINE),
          "host-release",
          "--root",
          deployment.installRoot,
          "--revision",
          upgrade.sourceCommit,
          "--outcome",
          outcome,
        ],
        path.join(directory, "host-release.log"),
      );
    return `${DIRECT_JOB_PREFIX}${upgrade.id}`;
  }

  /** The installer engine in the coordinator's own release, else in the Host's. */
  function adoptionEngine(): string {
    const releases: string[] = [];
    try {
      releases.push(releaseOfEntrypoint(entrypoint));
    } catch {
      /* not started from a release */
    }
    if (config.sourceUpdates) {
      try {
        releases.push(realpathSync(config.sourceUpdates.currentReleaseLink));
      } catch {
        /* no Host release selected */
      }
    }
    const engine = releases
      .map((release) => path.join(release, INSTALLER_ENGINE))
      .find((file) => existsSync(file));
    if (!engine) throw new Error("No release of this installation has the installer engine");
    return engine;
  }

  /** Runs the engine's `adopt` on this installation's root, detached; it restarts this process. */
  function launchAdoptionEngine(directory: string): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    spawnDetached(
      hostNode,
      [
        adoptionEngine(),
        "adopt",
        "--root",
        path.dirname(configFile),
        "--outcome",
        path.join(directory, "adoption.json"),
      ],
      path.join(directory, "adoption.log"),
    );
    logger.info({ directory }, "Installation adoption started");
  }

  const succeededHostUpdate = (job: RestartJob) =>
    job.target === "host" &&
    job.update !== undefined &&
    job.status === "succeeded" &&
    !job.reason.startsWith(UPGRADE_REASON_PREFIX);
  // Source updates that finished before this process started never trigger adoption.
  const earlierUpdates = new Set<string>();
  if (adoptable) {
    try {
      for (const job of restarts.list()) if (succeededHostUpdate(job)) earlierUpdates.add(job.id);
    } catch {
      /* the restart journal is unreadable; no update can trigger adoption */
    }
  }

  function adoptAfterSourceUpdate(): void {
    if (!adoptable) return;
    const directory = path.join(config.stateDir, "adoption");
    const launch = path.join(directory, "launch.json");
    // One automatic attempt; an upgrade from the interface retries after a failure.
    if (existsSync(launch)) return;
    const job = restarts
      .list()
      .find((item) => succeededHostUpdate(item) && !earlierUpdates.has(item.id));
    if (!job) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(
      launch,
      JSON.stringify({ jobId: job.id, launchedAt: new Date().toISOString() }, null, 2),
    );
    try {
      launchAdoptionEngine(directory);
    } catch (error) {
      logger.error({ err: error }, "Installation adoption could not start");
    }
  }

  async function git(args: string[], timeoutMs = 300_000) {
    return (await run("git", args, { timeoutMs })).trim();
  }

  /** Stage base..release as a bundle with the integration ref, exactly as Host agents upload. */
  async function stageHostUpdate(upgrade: InstallationUpgrade): Promise<SourceUpdate> {
    const settings = config.sourceUpdates;
    const source = config.deployment?.sourceDirectory;
    const base = currentCommit();
    if (!settings || !source || !hostUpdates || !base)
      throw new Error("Host source updates are unavailable");
    const work = path.join(upgradeDirectory, upgrade.id);
    const scratch = path.join(work, "bundle.git");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    await git(["init", "--bare", "--quiet", scratch]);
    // Fetch by ref, not by object ID: a local upload-pack may refuse unadvertised objects.
    // The release contains the installed commit, so its history brings the bundle's base.
    const temporary = `refs/vorteo-upgrade/${upgrade.id}`;
    await git(["-C", source, "update-ref", temporary, upgrade.sourceCommit]);
    try {
      await git([
        "-C",
        scratch,
        "fetch",
        "--quiet",
        "--no-tags",
        source,
        `${temporary}:${settings.integrationRef}`,
      ]);
    } finally {
      await git(["-C", source, "update-ref", "-d", temporary]);
    }
    await git(["-C", scratch, "merge-base", "--is-ancestor", base, upgrade.sourceCommit]).catch(
      () => {
        throw new Error(
          `Release ${upgrade.release} does not contain the installed Host source ${base}.`,
        );
      },
    );
    const bundle = path.join(work, "release.bundle");
    rmSync(bundle, { force: true });
    await git([
      "-C",
      scratch,
      "bundle",
      "create",
      "--quiet",
      bundle,
      settings.integrationRef,
      `^${base}`,
    ]);
    const bytes = readFileSync(bundle);
    const update: SourceUpdate = {
      sourceCommit: upgrade.sourceCommit,
      baseCommit: base,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    hostUpdates.stage(update, bytes);
    return update;
  }

  function upgradeJob(upgradeId: string): RestartJob | undefined {
    return restarts
      .list()
      .find((job) => job.target === "host" && job.reason.includes(upgradeId) && job.update);
  }

  const ports: UpgradePorts = {
    now: () => new Date(),
    adoptionRequired: adoptable,
    launchAdoption: (upgrade) => launchAdoptionEngine(path.join(upgradeDirectory, upgrade.id)),
    adoptionOutcome: (upgradeId) =>
      readAdoptionOutcome(path.join(upgradeDirectory, upgradeId, "adoption.json")),
    adoptionDeadlineMs: ADOPTION_DEADLINE_MS,
    hasContainer: config.container !== undefined,
    coordinatorReplacement: config.deployment?.coordinator
      ? null
      : "The installer did not record the coordinator release link. Restart the coordinator with the vorteo update command.",
    currentCommit,
    async resolveRelease(release) {
      const output = await run(
        "git",
        [
          "ls-remote",
          "--tags",
          VORTEO_RELEASE_GIT_URL,
          `refs/tags/${release}`,
          `refs/tags/${release}^{}`,
        ],
        { timeoutMs: 30_000 },
      );
      const lines = output.trim().split("\n").filter(Boolean);
      // An annotated tag lists its object and the peeled commit (^{}); prefer the commit.
      const line = lines.find((item) => item.endsWith("^{}")) ?? lines[0];
      const commit = line?.split(/\s+/)[0];
      if (!commit || !/^[a-f0-9]{40}$/.test(commit))
        throw new RestartRequestError(
          `Release ${release} was not found in ${VORTEO_RELEASE_REPOSITORY}`,
        );
      return commit;
    },
    async snapshot(upgrade) {
      if (!snapshots) throw new Error("Snapshots are unavailable");
      const snapshot = await snapshots.take({
        reason: "upgrade",
        upgradeId: upgrade.id,
        release: upgrade.release,
      });
      snapshots.prune([snapshot.id]);
      return snapshot.id;
    },
    async fetchRelease(upgrade) {
      const source = config.deployment?.sourceDirectory;
      if (!source) throw new Error("The source directory is unknown");
      const ref = `refs/tags/${upgrade.release}`;
      await git([
        "-C",
        source,
        "fetch",
        "--quiet",
        "--no-tags",
        VORTEO_RELEASE_GIT_URL,
        `+${ref}:${ref}`,
      ]);
      const commit = await git(["-C", source, "rev-parse", `${ref}^{commit}`]);
      if (commit !== upgrade.sourceCommit)
        throw new Error(
          `Release ${upgrade.release} now names ${commit}, not the reviewed ${upgrade.sourceCommit}. Request the upgrade again.`,
        );
    },
    async requestHostUpdate(upgrade) {
      if (directHostUpgrades(config)) return launchDirectHostRelease(upgrade);
      // A coordinator that restarted after creating the job reuses it.
      const existing = upgradeJob(upgrade.id);
      if (existing) return existing.id;
      const update = await stageHostUpdate(upgrade);
      const job = restarts.request(
        {
          target: "host",
          reason: `${UPGRADE_REASON_PREFIX} to ${upgrade.release} (${upgrade.id})`,
          requester: "Release upgrade",
        },
        "owner",
        update,
      );
      // The owner approved this exact release; the bundle is derived from its reviewed commit.
      restarts.decide(job.id, job.revision, "approve", update.sha256);
      return job.id;
    },
    hostUpdate(jobId) {
      if (jobId.startsWith(DIRECT_JOB_PREFIX)) {
        const outcome = directOutcome(jobId.slice(DIRECT_JOB_PREFIX.length));
        if (!existsSync(outcome))
          return { status: "running", detail: "Building the Host release." };
        const result = JSON.parse(readFileSync(outcome, "utf8"));
        return result.status === "succeeded"
          ? { status: "succeeded", detail: String(result.detail) }
          : { status: "failed", detail: String(result.detail ?? "The Host release failed.") };
      }
      const job = restarts.list().find((item) => item.id === jobId);
      if (!job) return { status: "failed", detail: "The Host update request disappeared." };
      if (job.status === "succeeded") return { status: "succeeded", detail: job.detail };
      if (job.status === "failed" || job.status === "rejected")
        return { status: "failed", detail: job.detail };
      return { status: "running", detail: job.detail };
    },
    hostRelease() {
      const link = config.deployment?.hostReleaseLink;
      if (directHostUpgrades(config) && link) return realpathSync(link);
      if (!config.sourceUpdates) throw new Error("Host source updates are unavailable");
      return realpathSync(config.sourceUpdates.currentReleaseLink);
    },
    runningRelease: () => releaseOfEntrypoint(entrypoint),
    coordinatorRelease() {
      const link = config.deployment?.coordinator?.releaseLink;
      if (!link) throw new Error("The coordinator release link is unknown");
      return readCurrentLink(link);
    },
    launchCoordinatorSwap(upgrade, next, previous) {
      const link = config.deployment?.coordinator?.releaseLink;
      if (!link || typeof services === "string")
        throw new Error("Coordinator replacement is unavailable");
      const directory = path.join(upgradeDirectory, upgrade.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const plan: CoordinatorSwapPlan = {
        kind: "coordinator-swap",
        id: upgrade.id,
        releaseLink: link,
        previous,
        next,
        services,
        health,
        outcomeFile: path.join(directory, "coordinator-handoff.json"),
        timeoutMs: COORDINATOR_READY_TIMEOUT_MS,
      };
      launchHandoff({
        node: process.execPath,
        helper: helper(),
        planFile: path.join(directory, "coordinator-handoff-plan.json"),
        logFile: path.join(directory, "coordinator-handoff.log"),
        plan,
      });
      logger.info({ upgradeId: upgrade.id }, "Coordinator handoff started");
    },
    coordinatorOutcome: (upgradeId) =>
      readHandoffOutcome(path.join(upgradeDirectory, upgradeId, "coordinator-handoff.json")),
    // Two readiness windows (new release, then rollback) plus restart slack.
    coordinatorDeadlineMs: COORDINATOR_READY_TIMEOUT_MS * 2 + 60_000,
    async devImage() {
      const directory = config.deployment?.containerDirectory;
      if (!directory) throw new Error("Dev's deployment directory is unknown");
      return readEnvImage(directory);
    },
    async buildDevImage(upgrade) {
      const source = config.deployment?.sourceDirectory;
      if (!source) throw new Error("The source directory is unknown");
      const work = path.join(upgradeDirectory, upgrade.id);
      const context = path.join(work, "dev-source");
      rmSync(context, { recursive: true, force: true });
      mkdirSync(context, { recursive: true, mode: 0o700 });
      const archive = path.join(work, "dev-source.tar");
      await git([
        "-C",
        source,
        "archive",
        "--format=tar",
        `--output=${archive}`,
        upgrade.sourceCommit,
      ]);
      await run("tar", ["-xf", archive, "-C", context], { timeoutMs: 300_000 });
      const iid = path.join(work, "dev-image.iid");
      rmSync(iid, { force: true });
      await run(
        "docker",
        [
          "build",
          "--build-arg",
          `PASEO_BUILD_COMMIT=${upgrade.sourceCommit}`,
          "--iidfile",
          iid,
          "-f",
          path.join(context, "docker/base/Dockerfile"),
          context,
        ],
        { timeoutMs: 90 * 60_000 },
      );
      return readFileSync(iid, "utf8").trim();
    },
    async replaceDevImage(image) {
      const directory = config.deployment?.containerDirectory;
      if (!directory) throw new Error("Dev's deployment directory is unknown");
      // update.sh waits for health and restores the previous image itself on failure.
      await run("/bin/bash", [path.join(directory, "update.sh"), image], {
        timeoutMs: 15 * 60_000,
      });
    },
    async verifyDev() {
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          const client = await connectInstallationDaemon(config, "container");
          try {
            await client.getDaemonStatus({ timeout: 15_000 });
            return;
          } finally {
            await client.close();
          }
        } catch (error) {
          if (Date.now() > deadline)
            throw new Error("The coordinator cannot reach the recreated Dev daemon", {
              cause: error,
            });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    },
  };

  const upgrades = blocker
    ? null
    : new InstallationUpgrades(createUpgradeJournal(upgradeDirectory), ports);

  function upgradeDetail(): string {
    if (blocker) return blocker;
    const steps = config.container
      ? "takes a snapshot, then restarts the Host daemon, replaces the coordinator and recreates the Dev container."
      : "takes a snapshot, then restarts the Host daemon and replaces the coordinator.";
    return adoptable
      ? `This installation predates the one-command installer. An upgrade first moves it to the installer layout in place${config.container ? ", with Dev in gate mode" : ""}, then ${steps}`
      : `An upgrade ${steps}`;
  }

  function readRestoreStatus(): SnapshotRestoreStatus | null {
    if (!restoreDirectory) return null;
    const file = path.join(restoreDirectory, "latest.json");
    if (!existsSync(file)) return null;
    try {
      return SnapshotRestoreStatusSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  return {
    upgrades,
    adoptAfterSourceUpdate,
    snapshots,
    snapshotList() {
      return {
        available: snapshots !== null,
        detail: snapshots
          ? `Snapshots are kept in ${snapshots.root}.`
          : "Snapshots need an installation made by the one-command installer.",
        retention: 5,
        snapshots: snapshots?.list() ?? [],
        restore: readRestoreStatus(),
      };
    },
    async takeSnapshot() {
      if (!snapshots)
        throw new RestartRequestError("Snapshots are unavailable on this installation");
      const snapshot = await snapshots.take({ reason: "owner" });
      snapshots.prune([snapshot.id]);
      return snapshot;
    },
    async restore(request) {
      if (!snapshots || !restoreDirectory)
        throw new RestartRequestError("Snapshots are unavailable on this installation");
      if (typeof services === "string") throw new RestartRequestError(services);
      if (upgrades?.active()?.status === "running")
        throw new RestartRequestError("Wait for the running upgrade to finish before restoring");
      if (readRestoreStatus()?.status === "running")
        throw new RestartRequestError("A restore is already running");
      const snapshot = snapshots.read(request.id);
      const confirmed = [
        ...new Set(request.parts.map((part) => SnapshotPartKindSchema.parse(part))),
      ].sort();
      if (JSON.stringify(confirmed) !== JSON.stringify(snapshotPartKinds(snapshot)))
        throw new RestartRequestError("The snapshot's contents changed. Review the restore again.");
      // Check every stored part before stopping anything.
      snapshots.storedParts(snapshot);
      // The current state stays restorable: take one more snapshot before replacing it.
      const before = await snapshots.take({ reason: "restore" });
      snapshots.prune([before.id, snapshot.id]);
      const id = randomUUID();
      const now = new Date().toISOString();
      const status: SnapshotRestoreStatus = {
        id,
        snapshotId: snapshot.id,
        status: "running",
        step: "Starting the restore helper",
        detail: `The state before this restore is saved as snapshot ${before.id}.`,
        startedAt: now,
        updatedAt: now,
      };
      const statusFile = path.join(restoreDirectory, "latest.json");
      writePrivateFileAtomicSync(statusFile, JSON.stringify(status, null, 2));
      const plan: RestorePlan = {
        kind: "restore",
        id,
        snapshotRoot: snapshots.root,
        snapshotId: snapshot.id,
        services,
        health,
        statusFile,
        timeoutMs: COORDINATOR_READY_TIMEOUT_MS,
      };
      launchHandoff({
        node: process.execPath,
        helper: helper(),
        planFile: path.join(restoreDirectory, `${id}.plan.json`),
        logFile: path.join(restoreDirectory, `${id}.log`),
        plan,
      });
      logger.info({ snapshotId: snapshot.id, restoreId: id }, "Snapshot restore started");
      return status;
    },
    upgradeStatus() {
      const commit = currentCommit();
      return {
        available: upgrades !== null,
        detail: upgradeDetail(),
        repository: VORTEO_RELEASE_REPOSITORY,
        current: commit
          ? {
              sourceCommit: commit,
              release:
                upgrades
                  ?.list()
                  .find((item) => item.status === "succeeded" && item.sourceCommit === commit)
                  ?.release ?? null,
            }
          : null,
        container: config.container !== undefined,
        upgrades: upgrades?.list() ?? [],
      };
    },
  };
}
