import type {
  SessionHostJob,
  SessionHostOperation,
  SessionHostStatus,
} from "@getpaseo/protocol/session-host-maintenance";

/** The owner query result: every job the coordinator retains and what it observes now. */
export interface SessionHostOverview {
  jobs: SessionHostJob[];
  /** Null when the coordinator could not inspect the job, such as a failed launchctl read. */
  status: SessionHostStatus | null;
  /** The coordinator accepts restart requests; older coordinators leave this unset. */
  restartSupported?: boolean;
}

const STATUS_UNAVAILABLE = "Session host status is unavailable.";

export type SessionHostAction = "approve" | "cancel";

interface SessionHostReviewState {
  busy: boolean;
  unlocked: boolean;
}

const OPERATION_TITLES: Record<SessionHostOperation, string> = {
  "session-host-install": "Install the session host job",
  "session-host-remove": "Remove the session host job",
  "session-host-restart": "Restart the session host",
};

export function sessionHostOperationTitle(operation: SessionHostOperation): string {
  return OPERATION_TITLES[operation];
}

/** Jobs that still occupy the session host label: a second request would conflict with them. */
export function isActiveSessionHostJob(job: Pick<SessionHostJob, "status">): boolean {
  return job.status === "pending" || job.status === "approved" || job.status === "running";
}

/** Active jobs first, newest first, then the most recent finished job so its result stays visible. */
export function visibleSessionHostJobs(jobs: readonly SessionHostJob[]): SessionHostJob[] {
  const newestFirst = jobs.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const active = newestFirst.filter(isActiveSessionHostJob);
  const finished = newestFirst.find((job) => !isActiveSessionHostJob(job));
  return finished ? [...active, finished] : active;
}

export function sessionHostActionDisabledReason(
  job: Pick<SessionHostJob, "status" | "stage">,
  action: SessionHostAction,
  state: SessionHostReviewState,
): string | null {
  if (state.busy) return "Wait for the current action to finish, then refresh its result.";
  if (!state.unlocked) return "Unlock Installation controls to review this session host request.";
  if (action === "cancel")
    return job.status === "pending" || job.status === "approved"
      ? null
      : "This request has dispatched or finished. Inspect its result.";
  return job.status === "pending" && job.stage === "prepared"
    ? null
    : "This request is no longer awaiting approval. Refresh and review any replacement request.";
}

/**
 * Why the owner cannot request an operation now. The coordinator enforces the same rules; this
 * explains them before a refused request.
 */
export function sessionHostRequestDisabledReason(
  operation: SessionHostOperation,
  overview: SessionHostOverview,
  state: SessionHostReviewState,
): string | null {
  if (state.busy) return "Wait for the current action to finish, then refresh its result.";
  if (!state.unlocked) return "Unlock Installation controls to request a session host change.";
  // Without an observation neither operation can be judged safe to request.
  if (!overview.status) return STATUS_UNAVAILABLE;
  if (overview.jobs.some(isActiveSessionHostJob))
    return "A session host request is already open. Approve, cancel or wait for it first.";
  const { status } = overview;
  if (operation === "session-host-install") {
    if (!status.supported)
      return "The installed release has no session host. Update the Host before installing it.";
    if (status.installed) return "The session host job is already installed.";
    return null;
  }
  if (!status.installed) return "The session host job is not installed.";
  if (operation === "session-host-restart") {
    if (!status.supported)
      return "The installed release has no session host. Update the Host before restarting it.";
    if (!status.detail?.loaded) return "The session host job is not loaded. Remove and install it.";
    return null;
  }
  if (status.detail?.settingEnabled)
    return "Turn off durable sessions first. Removal is refused while the setting is on.";
  if (status.detail?.host?.sessions)
    return "Hosted sessions are still running. Removal is refused until none remain.";
  return null;
}

/** What a restart interrupts right now, from the last observation. */
export function sessionHostRestartWarning(status: SessionHostStatus | null): string {
  const sessions = status?.detail?.host?.sessions;
  if (sessions === undefined)
    return "Restarting interrupts every hosted turn; each continues on the new host.";
  if (sessions === 0) return "No hosted session is running now, so a restart interrupts nothing.";
  return `Restarting interrupts ${sessions} hosted turn${sessions === 1 ? "" : "s"}; each continues on the new host.`;
}

export function sessionHostReviewSummary(
  job: Pick<SessionHostJob, "operation" | "status" | "stage" | "forcedStop" | "previousHost">,
): string {
  const install = job.operation === "session-host-install";
  if (job.operation === "session-host-restart") return sessionHostRestartSummary(job);
  if (job.status === "running")
    return install
      ? "Installing the job and waiting for the session host to answer."
      : "Stopping the session host and removing its job.";
  if (job.status === "succeeded") {
    if (install) return "The session host job is installed and its host answered.";
    return job.forcedStop
      ? "The session host job is removed. The host had stopped answering, so it was stopped by force."
      : "The session host job is removed.";
  }
  if (job.status === "rejected") return "This session host request was canceled.";
  if (job.status === "failed")
    return "This request failed without further effect. Inspect its detail before requesting again.";
  if (job.status === "approved") return "Approved. The coordinator will apply this plan next.";
  return install
    ? "Install the session host as its own launchd job. Agents keep running, and durable sessions stay off until you enable them."
    : "Remove the session host job. Agents keep running; hosted sessions must be closed and the setting off.";
}

function sessionHostRestartSummary(job: Pick<SessionHostJob, "status" | "previousHost">): string {
  if (job.status === "running")
    return "Stopping the session host and waiting for its replacement to answer.";
  if (job.status === "succeeded") {
    const interrupted = job.previousHost?.sessions;
    return interrupted === undefined
      ? "The session host restarted on the installed release."
      : `The session host restarted on the installed release; ${interrupted} hosted turn${interrupted === 1 ? " was interrupted and continues" : "s were interrupted and continue"} there.`;
  }
  if (job.status === "rejected") return "This session host request was canceled.";
  if (job.status === "failed")
    return "This request failed. launchd keeps the job loaded; inspect its detail and status before requesting again.";
  if (job.status === "approved")
    return "Approved. The coordinator will restart the session host next.";
  return "Restart the session host on the installed release. Every hosted turn running at that moment is interrupted and continues on the new host; the job and the setting are unchanged.";
}

/**
 * The reviewed plan, one fact per line, including the job's whole environment: HOME, PATH and
 * PASEO_HOME are all it receives. Approval binds to the plan digest on the last line.
 */
export function sessionHostPlanLines(job: Pick<SessionHostJob, "plan" | "planSha256">): string[] {
  const { plan } = job;
  return [
    `Label: ${plan.label}`,
    `Plist: ${plan.plistPath}`,
    `Node: ${plan.node}`,
    `Entrypoint: ${plan.entrypoint}`,
    `Working directory: ${plan.workingDirectory}`,
    `PASEO_HOME: ${plan.paseoHome}`,
    `HOME: ${plan.environment.HOME}`,
    `PATH: ${plan.environment.PATH}`,
    `Log: ${plan.logPath}`,
    `Plist SHA-256: ${plan.plistSha256 ?? "none"}`,
    `Plan: ${job.planSha256}`,
  ];
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** "3 (claude 2, codex 1)" when the host reports providers, else the plain count. */
function hostedSessionsText(host: {
  sessions: number;
  providers?: Record<string, number>;
}): string {
  const entries = Object.entries(host.providers ?? {}).filter(([, count]) => count > 0);
  if (entries.length === 0) return String(host.sessions);
  return `${host.sessions} (${entries.map(([provider, count]) => `${provider} ${count}`).join(", ")})`;
}

/** What the coordinator last observed, without tokens or socket paths. */
export function sessionHostStatusLines(status: SessionHostStatus | null): string[] {
  if (!status) return ["Status unavailable"];
  const lines = [`Installed: ${yesNo(status.installed)}`];
  if (!status.supported) lines.push("Release support: the installed release has no session host");
  const detail = status.detail;
  if (!detail) return [...lines, "Details are unavailable to this client."];
  lines.push(
    `Loaded: ${yesNo(detail.loaded)}`,
    `Process: ${detail.pid ?? "none"}`,
    `Last exit: ${detail.lastExitStatus ?? "none"}`,
    `Runs: ${detail.runs ?? "unknown"}`,
    `Host release: ${detail.host?.release ?? (detail.host ? "unknown" : "not answering")}`,
    ...(detail.installedRelease ? [`Installed release: ${detail.installedRelease}`] : []),
    `Hosted sessions: ${detail.host ? hostedSessionsText(detail.host) : "unknown"}`,
    `Durable sessions setting: ${detail.settingEnabled ? "on" : "off"}`,
    // The coordinator caches its observation briefly, so this can trail the present.
    `Observed: ${detail.observedAt}`,
  );
  if (detail.plist === "different")
    lines.push("Plist: differs from the coordinator's plan. Remove the job and install it again.");
  return lines;
}
