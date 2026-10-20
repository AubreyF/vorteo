import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  SessionHostPlanSchema,
  type SessionHostJob,
  type SessionHostOperation,
  type SessionHostPlan,
  type SessionHostStatus,
} from "@getpaseo/protocol/session-host-maintenance";
import type { SessionHostLockState } from "../session-host/host-files.js";
import {
  bootoutJob,
  bootstrapJob,
  LaunchctlError,
  printJob,
  renderSessionHostPlist,
  runLaunchdCommand,
  type CommandRunner,
} from "../session-host/launchd.js";
import type { InstallationConfig } from "./config.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";

/** Where a release keeps the session host entrypoint; a release without it has no support. */
export const SESSION_HOST_ENTRYPOINT = "packages/server/dist/scripts/session-host-entrypoint.js";
/** The client release the coordinator reports when it asks the host for status. */
export const SESSION_HOST_STATUS_RELEASE = "installation-coordinator-status";

/** An install must see the new host answer within this. */
const INSTALL_ANSWER_DEADLINE_MS = 60_000;
/**
 * The workers' alive window. A host that has not answered for this long, with the setting off,
 * has had every hosted session declared lost by its workers, so stopping it is safe.
 */
export const FORCED_STOP_AFTER_MS = 300_000;
const UNANSWERED_POLL_MS = 10_000;
/** launchd's ExitTimeOut for the job, plus a margin for its SIGKILL to land. */
const STOP_WAIT_MS = 35_000;
/** How long launchd may keep listing a job whose process already exited. */
const UNLIST_WAIT_MS = 10_000;
const WATCHDOG_KILL_MESSAGE = "Session host watchdog is killing the host";

/** A session host operation that cannot proceed; the message is written for the owner. */
export class SessionHostJobError extends BootstrapRequestConflict {
  constructor(message: string) {
    super(message);
    this.name = "SessionHostJobError";
  }
}

export interface SessionHostAnswer {
  pid: number;
  release?: string;
  sessions: number;
}

/** Every effect the job has, so tests run without launchctl or a live installation. */
export interface SessionHostPorts {
  uid: number;
  /** The user's LaunchAgents directory, where launchd plists live. */
  launchAgentsDirectory: string;
  /** Runs launchctl and plutil without a shell. Undefined means the real commands. */
  run?: CommandRunner;
  readFile(file: string): Promise<Buffer | null>;
  writePrivateFile(file: string, data: string): Promise<void>;
  removeFile(file: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  preparePrivateDirectory(directory: string): Promise<void>;
  /**
   * The host's identity and session count; "refused" when it closed the connection before
   * greeting, which only a live host can do; null when it does not answer at all.
   */
  queryHost(paseoHome: string): Promise<SessionHostAnswer | "refused" | null>;
  /** What the host lock proves; see readSessionHostLock. */
  hostLock(paseoHome: string): Promise<SessionHostLockState>;
  processCommand(pid: number): Promise<string | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
  settingEnabled(paseoHome: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function sessionHostLabel(installationId: string): string {
  return `local.vorteo.${installationId}.session-host`;
}

/** The user's LaunchAgents directory, where the Host and session host plists live. */
export function defaultLaunchAgentsDirectory(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

export function sessionHostPlistPath(
  installationId: string,
  launchAgentsDirectory: string,
): string {
  return path.join(launchAgentsDirectory, `${sessionHostLabel(installationId)}.plist`);
}

export function sessionHostPlanSha256(plan: SessionHostPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireConfigured<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null)
    throw new SessionHostJobError(`The session host job requires ${what}.`);
  return value;
}

/** The Host job's label and its launchd domain uid, from the configured service. */
function hostService(config: InstallationConfig): { uid: number; label: string } {
  const match = /^gui\/(\d+)\/(.+)$/.exec(config.host.launchdService);
  if (!match) throw new SessionHostJobError("The Host service name is not a launchd GUI service.");
  return { uid: Number(match[1]), label: match[2]! };
}

/**
 * HOME and PATH as the Host job runs with them, so providers see the same environment. The Host
 * job must also run on the configured PASEO_HOME, or the host would serve another home's agents.
 */
async function hostEnvironment(
  config: InstallationConfig,
  home: string,
  ports: SessionHostPorts,
): Promise<{ HOME: string; PATH: string }> {
  const { label } = hostService(config);
  const plist = path.join(ports.launchAgentsDirectory, `${label}.plist`);
  if (!(await ports.exists(plist)))
    throw new SessionHostJobError("The Host job's plist is missing.");
  const { stdout } = await (ports.run ?? runLaunchdCommand)("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    plist,
  ]);
  const parsed = JSON.parse(stdout) as { EnvironmentVariables?: Record<string, unknown> };
  const userHome = parsed.EnvironmentVariables?.HOME;
  const pathValue = parsed.EnvironmentVariables?.PATH;
  if (typeof userHome !== "string" || !userHome.startsWith("/") || typeof pathValue !== "string")
    throw new SessionHostJobError("The Host job does not define HOME and PATH.");
  if (parsed.EnvironmentVariables?.PASEO_HOME !== home)
    throw new SessionHostJobError(
      "The Host job's PASEO_HOME differs from the coordinator's Host configuration.",
    );
  return { HOME: userHome, PATH: pathValue };
}

/** The plist an install writes, rendered from the plan alone. */
export function renderPlannedPlist(plan: SessionHostPlan): string {
  return renderSessionHostPlist({
    label: plan.label,
    nodePath: plan.node,
    entrypointPath: plan.entrypoint,
    paseoHome: plan.paseoHome,
    logPath: plan.logPath,
    environment: { HOME: plan.environment.HOME, PATH: plan.environment.PATH },
    workingDirectory: plan.workingDirectory,
  });
}

/**
 * Computes the exact plan for an operation from the coordinator's own configuration. Approval
 * binds its hash, and dispatch computes it again and refuses any difference.
 */
export async function deriveSessionHostPlan(input: {
  config: InstallationConfig;
  operation: SessionHostOperation;
  ports: SessionHostPorts;
}): Promise<SessionHostPlan> {
  const { config, operation, ports } = input;
  const current = requireConfigured(
    config.sourceUpdates?.currentReleaseLink,
    "source updates through the current release link",
  );
  const validation = requireConfigured(config.host.startupValidation, "Host startup validation");
  const service = hostService(config);
  if (service.uid !== ports.uid)
    throw new SessionHostJobError("The coordinator does not run as the Host job's user.");
  const label = sessionHostLabel(config.public.installationId);
  const plistPath = sessionHostPlistPath(config.public.installationId, ports.launchAgentsDirectory);
  const partial = {
    version: 1 as const,
    operation,
    installationId: config.public.installationId,
    label,
    serviceDomain: `gui/${service.uid}`,
    plistPath,
    node: validation.node,
    entrypoint: path.join(current, SESSION_HOST_ENTRYPOINT),
    paseoHome: validation.home,
    logPath: path.join(validation.home, "session-host", "launchd.log"),
    workingDirectory: path.join(current, "packages/server"),
    environment: await hostEnvironment(config, validation.home, ports),
  };
  const planned = { ...partial, plistSha256: null };
  if (operation === "session-host-install") {
    const rendered = renderPlannedPlist(SessionHostPlanSchema.parse(planned));
    return SessionHostPlanSchema.parse({ ...partial, plistSha256: digest(rendered) });
  }
  const existing = await ports.readFile(plistPath);
  return SessionHostPlanSchema.parse({
    ...partial,
    plistSha256: existing ? digest(existing) : null,
  });
}

function launchdOptions(ports: SessionHostPorts) {
  return { allowProductionLabel: true, ...(ports.run ? { run: ports.run } : {}) };
}

/** Top-level fields of `launchctl print`, which indents nested records further. */
function launchdField(output: string, field: string): number | null {
  const match = new RegExp(`^\\t${field} = (-?\\d+)$`, "m").exec(output);
  return match ? Number(match[1]) : null;
}

/** launchd's record of a loaded job, or null when none is loaded under the label. */
export async function readLaunchdJob(label: string, ports: SessionHostPorts) {
  const output = await printJob(label, launchdOptions(ports));
  if (output === null) return null;
  return {
    pid: launchdField(output, "pid"),
    runs: launchdField(output, "runs"),
    lastExitStatus: launchdField(output, "last exit code"),
  };
}

/** True when the host log shows a watchdog kill at or after the given time. */
async function watchdogKilledSince(
  plan: SessionHostPlan,
  since: number,
  ports: SessionHostPorts,
): Promise<boolean> {
  const log = await ports.readFile(path.join(plan.paseoHome, "session-host", "host.log"));
  if (!log) return false;
  return log
    .toString("utf8")
    .split("\n")
    .some((line) => {
      if (!line.includes(WATCHDOG_KILL_MESSAGE)) return false;
      try {
        const time = (JSON.parse(line) as { time?: unknown }).time;
        return typeof time === "number" && time >= since;
      } catch {
        return false;
      }
    });
}

/**
 * Installs the job, or confirms an identical one, then requires the new host to answer. A job
 * this call bootstrapped is booted out and its plist deleted if the host never answers.
 */
export async function installSessionHost(input: {
  plan: SessionHostPlan;
  ports: SessionHostPorts;
  reportStage(stage: "applying" | "verifying"): void;
}): Promise<{ detail: string; host: { pid: number; release?: string } }> {
  const { plan, ports } = input;
  if (plan.operation !== "session-host-install")
    throw new SessionHostJobError("This plan does not install the session host job.");
  if (plan.serviceDomain !== `gui/${ports.uid}`)
    throw new SessionHostJobError("The plan belongs to another user's launchd domain.");
  if (!(await ports.exists(plan.entrypoint)))
    throw new SessionHostJobError(
      "The selected release has no session host. Install a release that includes it first.",
    );
  const rendered = renderPlannedPlist(plan);
  if (digest(rendered) !== plan.plistSha256)
    throw new SessionHostJobError("The planned plist changed. Prepare and review a new request.");
  input.reportStage("applying");
  const startedAt = ports.now();
  const existing = await ports.readFile(plan.plistPath);
  const loaded = await readLaunchdJob(plan.label, ports);
  let bootstrapped = false;
  if (existing) {
    if (digest(existing) !== plan.plistSha256 || !loaded)
      throw new SessionHostJobError(
        "A different session host job is installed. Remove it from Installation controls first.",
      );
  } else if (loaded) {
    throw new SessionHostJobError(
      "The session host job is loaded without its plist. Remove it from Installation controls first.",
    );
  } else {
    // launchd opens the job's log before the host runs, so its directory must already exist.
    await ports.preparePrivateDirectory(path.join(plan.paseoHome, "session-host"));
    await ports.writePrivateFile(plan.plistPath, rendered);
    try {
      await bootstrapJob(plan.plistPath, launchdOptions(ports));
    } catch (error) {
      await ports.removeFile(plan.plistPath);
      throw error;
    }
    bootstrapped = true;
  }
  input.reportStage("verifying");
  const deadline = ports.now() + INSTALL_ANSWER_DEADLINE_MS;
  let failure = "The session host did not answer after installation.";
  for (;;) {
    const reply = await ports.queryHost(plan.paseoHome);
    const answer = reply === "refused" ? null : reply;
    const job = answer ? await readLaunchdJob(plan.label, ports) : null;
    if (answer && job?.pid === answer.pid) {
      if (await watchdogKilledSince(plan, startedAt, ports)) {
        // Strict on purpose: a host killed during the check is not accepted even though
        // launchd starts another one.
        failure = "The session host watchdog killed the host during the install check.";
        break;
      }
      return {
        detail: `The session host job is installed and host ${answer.pid} answered. The durable sessions setting was not changed.`,
        host: { pid: answer.pid, ...(answer.release ? { release: answer.release } : {}) },
      };
    }
    if (ports.now() >= deadline) break;
    await ports.sleep(1_000);
  }
  if (bootstrapped) {
    await bootoutJob(plan.label, launchdOptions(ports)).catch(() => {});
    await ports.removeFile(plan.plistPath);
    throw new SessionHostJobError(`${failure} The job was removed again; inspect its log.`);
  }
  throw new SessionHostJobError(
    `${failure} Inspect its status, or remove the job from Installation controls.`,
  );
}

/**
 * Removes the job. Refused while the setting is on or the host runs sessions. A host that stops
 * answering is stopped anyway once the setting is off and it has been silent past the workers'
 * alive window: by then every worker has declared its sessions lost, and a dead host pid turns
 * into immediate loss in any later worker, so no second provider can appear. The clock starts at
 * the first unanswered poll, which is not any worker's window and promises nothing stronger.
 */
export async function removeSessionHost(input: {
  plan: SessionHostPlan;
  ports: SessionHostPorts;
  reportStage(stage: "applying" | "verifying"): void;
}): Promise<{ detail: string; forced: boolean }> {
  const { plan, ports } = input;
  if (plan.operation !== "session-host-remove")
    throw new SessionHostJobError("This plan does not remove the session host job.");
  if (plan.serviceDomain !== `gui/${ports.uid}`)
    throw new SessionHostJobError("The plan belongs to another user's launchd domain.");
  const settingOn = () => ports.settingEnabled(plan.paseoHome);
  if (await settingOn())
    throw new SessionHostJobError(
      "Turn the durable sessions setting off before removing the session host job.",
    );
  const existing = await ports.readFile(plan.plistPath);
  if ((existing ? digest(existing) : null) !== plan.plistSha256)
    throw new SessionHostJobError(
      "The session host plist changed. Prepare and review a new request.",
    );
  input.reportStage("applying");
  let forced = false;
  let silentSince: number | null = null;
  const startedAt = ports.now();
  for (;;) {
    const answer = await ports.queryHost(plan.paseoHome);
    if (answer === "refused") {
      // Refusing a connection proves the host is alive and may be serving workers, so it is
      // never silent enough to force. Give up rather than wait forever.
      silentSince = null;
      if (ports.now() - startedAt >= FORCED_STOP_AFTER_MS)
        throw new SessionHostJobError(
          "The session host keeps refusing connections and may still run sessions. Nothing was changed; try again later.",
        );
      await ports.sleep(UNANSWERED_POLL_MS);
      continue;
    }
    if (answer) {
      if (answer.sessions > 0)
        throw new SessionHostJobError(
          `The session host still runs ${answer.sessions} hosted session${answer.sessions === 1 ? "" : "s"}. Wait for them to finish, then retry.`,
        );
      break;
    }
    if ((await ports.hostLock(plan.paseoHome)).state === "gone") break;
    silentSince ??= ports.now();
    if (ports.now() - silentSince >= FORCED_STOP_AFTER_MS) {
      if (await settingOn())
        throw new SessionHostJobError(
          "The durable sessions setting was turned on. The session host job was not removed.",
        );
      forced = true;
      break;
    }
    await ports.sleep(UNANSWERED_POLL_MS);
  }
  if (await settingOn())
    throw new SessionHostJobError(
      "The durable sessions setting was turned on. The session host job was not removed.",
    );
  await bootoutJob(plan.label, launchdOptions(ports)).catch((error: unknown) => {
    // Not loaded is fine: the plist is all that is left to remove.
    if (!(error instanceof LaunchctlError && error.exitCode === 113)) throw error;
  });
  input.reportStage("verifying");
  await stopLockHolder(plan, ports);
  // bootout returns before launchd has finished with the job, so give its record a moment.
  const listedUntil = ports.now() + UNLIST_WAIT_MS;
  while ((await readLaunchdJob(plan.label, ports)) !== null) {
    if (ports.now() >= listedUntil)
      throw new SessionHostJobError("launchd still lists the session host job after bootout.");
    await ports.sleep(500);
  }
  await ports.removeFile(plan.plistPath);
  return {
    detail: forced
      ? "The session host did not answer for five minutes with the setting off, so it was stopped and its job removed."
      : "The session host job is removed.",
    forced,
  };
}

/** Waits for the host process to exit, then SIGKILLs it if it is still the session host. */
async function stopLockHolder(plan: SessionHostPlan, ports: SessionHostPorts): Promise<void> {
  const deadline = ports.now() + STOP_WAIT_MS;
  for (;;) {
    const lock = await ports.hostLock(plan.paseoHome);
    if (lock.state === "gone") return;
    if (ports.now() >= deadline) {
      const pid = lock.pid;
      const command = pid === null ? null : await ports.processCommand(pid);
      if (pid === null || !command?.includes("session-host-entrypoint"))
        throw new SessionHostJobError(
          "The host lock is not held by a verifiable session host process. Nothing was killed.",
        );
      ports.kill(pid, "SIGKILL");
      await ports.sleep(1_000);
      const after = await ports.hostLock(plan.paseoHome);
      if (after.state === "alive" && after.pid === pid)
        throw new SessionHostJobError("The session host process survived SIGKILL.");
      return;
    }
    await ports.sleep(1_000);
  }
}

/** Whether an installed plist is the one an install would write now. */
async function comparePlist(
  config: InstallationConfig,
  ports: SessionHostPorts,
  plist: Buffer | null,
): Promise<"absent" | "matching" | "different"> {
  if (!plist) return "absent";
  try {
    const planned = await deriveSessionHostPlan({
      config,
      operation: "session-host-install",
      ports,
    });
    return digest(plist) === planned.plistSha256 ? "matching" : "different";
  } catch {
    return "different";
  }
}

/**
 * What the coordinator observes about the job. Details are for the Host token and owners only;
 * the host is asked only when detail is requested, so status checks stay out of its audit log.
 */
export async function inspectSessionHost(input: {
  config: InstallationConfig;
  ports: SessionHostPorts;
  detail: boolean;
}): Promise<SessionHostStatus> {
  const { config, ports } = input;
  const current = config.sourceUpdates?.currentReleaseLink;
  const supported = current
    ? await ports.exists(path.join(current, SESSION_HOST_ENTRYPOINT))
    : false;
  const label = sessionHostLabel(config.public.installationId);
  const plist = await ports.readFile(
    sessionHostPlistPath(config.public.installationId, ports.launchAgentsDirectory),
  );
  const job = await readLaunchdJob(label, ports);
  const installed = plist !== null || job !== null;
  if (!input.detail) return { supported, installed };
  const plistState = await comparePlist(config, ports, plist);
  const home = config.host.startupValidation?.home;
  const reply = home && job ? await ports.queryHost(home) : null;
  const answer = reply === "refused" ? null : reply;
  return {
    supported,
    installed,
    detail: {
      label,
      plist: plistState,
      loaded: job !== null,
      pid: job?.pid ?? null,
      lastExitStatus: job?.lastExitStatus ?? null,
      runs: job?.runs ?? null,
      host: answer
        ? {
            pid: answer.pid,
            ...(answer.release ? { release: answer.release } : {}),
            sessions: answer.sessions,
          }
        : null,
      settingEnabled: home ? await ports.settingEnabled(home) : false,
      observedAt: new Date(ports.now()).toISOString(),
    },
  };
}

/** The coordinator's session host operations over the given effects. */
export function createSessionHostExecutor(input: {
  config: InstallationConfig;
  ports: SessionHostPorts;
}) {
  const { config, ports } = input;
  return {
    sessionHostPlan: (operation: SessionHostOperation) =>
      deriveSessionHostPlan({ config, operation, ports }),
    applySessionHost: (
      job: SessionHostJob,
      reportStage: (stage: "applying" | "verifying") => void,
    ): Promise<{ detail: string; host?: SessionHostJob["host"]; forced?: boolean }> =>
      job.operation === "session-host-install"
        ? installSessionHost({ plan: job.plan, ports, reportStage })
        : removeSessionHost({ plan: job.plan, ports, reportStage }),
    inspectSessionHost: (detail: boolean) => inspectSessionHost({ config, ports, detail }),
  };
}
