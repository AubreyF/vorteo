import type { NativeHelperJob } from "@getpaseo/protocol/native-helper-maintenance";
import { helperActionDisabledReason, type HelperReviewAction } from "./helper-review";
import type {
  ProfileSharingStatus,
  RestartJob,
  RestartDecision,
  RestartSummary,
} from "@getpaseo/protocol/execution-installation";
import { OwnerAccessExpired, type InstallationClient } from "./client";

interface InstallationPanelState {
  restartSummary: RestartSummary | null;
  initialized: boolean;
  lastUpdatedAt: string | null;
  visible: boolean;
  unlocked: boolean;
  busy: boolean;
  password: string;
  error: string | null;
  notice: string | null;
  jobs: RestartJob[];
  helperJobs: NativeHelperJob[];
  helperError: string | null;
  pendingJobs: RestartJob[];
  profileSharing: ProfileSharingStatus | null;
  passwordFile: string | null;
  sessionsSupported: boolean;
}

export class InstallationPanelModel {
  private state: InstallationPanelState = {
    restartSummary: null,
    initialized: false,
    lastUpdatedAt: null,
    visible: true,
    unlocked: false,
    busy: false,
    password: "",
    error: null,
    notice: null,
    jobs: [],
    helperJobs: [],
    helperError: null,
    pendingJobs: [],
    profileSharing: null,
    passwordFile: null,
    sessionsSupported: false,
  };
  private listeners = new Set<() => void>();
  private refreshing = false;
  private initialized = false;
  private accessGeneration = 0;

  constructor(
    private readonly client: Pick<
      InstallationClient,
      | "unlock"
      | "listRestarts"
      | "listHelpers"
      | "decideHelper"
      | "restartSummary"
      | "decide"
      | "profileSharingStatus"
      | "resolveProfileConflict"
      | "restoreSession"
      | "lock"
      | "passwordFile"
      | "sessionsSupported"
    >,
    private readonly options: { connectionsRegistered: boolean; openRequested?: boolean } = {
      connectionsRegistered: false,
    },
  ) {
    this.state.visible = Boolean(options.openRequested) || !options.connectionsRegistered;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.publish({ busy: true });
    try {
      const unlocked = await this.client.restoreSession();
      this.publish({
        unlocked,
        passwordFile: this.client.passwordFile,
        sessionsSupported: this.client.sessionsSupported,
        ...(unlocked ? { visible: Boolean(this.options.openRequested) } : {}),
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false, initialized: true });
    }
  }

  async lock(): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.lock();
      this.accessGeneration++;
      this.publish({
        unlocked: false,
        lastUpdatedAt: null,
        password: "",
        jobs: [],
        helperJobs: [],
        helperError: null,
        pendingJobs: [],
        profileSharing: null,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  getState = (): InstallationPanelState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  open(): void {
    this.publish({ visible: true });
  }
  close(): void {
    if (!this.state.busy) this.publish({ visible: false });
  }
  setPassword(password: string): void {
    this.publish({ password });
  }

  async unlock(): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.unlock(this.state.password);
      this.publish({ unlocked: true, password: "", visible: false });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    const generation = this.accessGeneration;
    try {
      const restartSummary = await this.client.restartSummary();
      this.publish({ restartSummary });
      if (!this.state.unlocked) return;
      const [jobs, profileSharing, helperJobs] = await Promise.all([
        this.client.listRestarts(),
        this.client.profileSharingStatus(),
        this.client.listHelpers(),
      ]);
      if (generation !== this.accessGeneration) return;
      const targets = new Set(
        jobs
          .filter((job) => job.status === "approved" || job.status === "running")
          .map((job) => job.target),
      );
      const pending = jobs.toReversed().filter((job) => {
        if (job.status !== "pending") return false;
        if (
          job.update ||
          job.sourceBatch ||
          job.supervisorPlanSha256 ||
          job.factoryRuntimePlanSha256
        )
          return true;
        if (targets.has(job.target)) return false;
        targets.add(job.target);
        return true;
      });
      this.publish({
        jobs,
        helperJobs,
        pendingJobs: pending,
        profileSharing,
        lastUpdatedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
    }
  }

  dismissHelperError(): void {
    this.publish({ helperError: null });
  }

  async decideHelper(job: NativeHelperJob, action: HelperReviewAction): Promise<void> {
    if (this.state.busy) return;
    const current = this.state.helperJobs.find((item) => item.id === job.id);
    if (!current || current.revision !== job.revision || current.planSha256 !== job.planSha256) {
      this.publish({
        helperError: "Helper request changed. Refresh and review the current artifact.",
      });
      return;
    }
    const reason = helperActionDisabledReason(current, action, this.state);
    if (reason) {
      this.publish({ helperError: reason });
      return;
    }
    this.publish({ busy: true, error: null, helperError: null, notice: null });
    try {
      const result = await this.client.decideHelper(current, action);
      this.publish({
        helperJobs: this.state.helperJobs.map((item) => (item.id === result.id ? result : item)),
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
      this.publish({
        error: null,
        helperError:
          error instanceof Error
            ? error.message
            : "Helper decision unconfirmed. Refresh before retrying.",
      });
    } finally {
      this.publish({ busy: false });
    }
  }

  async decide(job: RestartJob, decision: RestartDecision): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.decide(job, decision);
      const notices = {
        approve: "Restart approved. Its progress is shown here.",
        "approve-when-idle":
          "Restart queued. It will run when no agents will be interrupted, even if you close this page.",
        "finish-current-turns": "New work is held while current turns finish.",
        "request-again": "Restart requested again. Review it before approving.",
        cancel: "Queued restart cancelled.",
        reject: "Restart request rejected.",
      };
      const notice = notices[decision];
      this.publish({ notice });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  async resolveProfileConflict(serverId: string, choice: "shared" | "environment"): Promise<void> {
    const snapshot = this.state.profileSharing;
    if (this.state.busy || !snapshot) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.resolveProfileConflict({
        serverId,
        expectedRevision: snapshot.revision,
        choice,
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  private fail(error: unknown): void {
    if (error instanceof OwnerAccessExpired)
      this.publish({
        unlocked: false,
        visible: false,
        lastUpdatedAt: null,
        password: "",
        jobs: [],
        helperJobs: [],
        helperError: null,
        pendingJobs: [],
        profileSharing: null,
      });
    this.publish({ error: error instanceof Error ? error.message : "Installation request failed" });
  }
  private publish(update: Partial<InstallationPanelState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
}

export function restartExplanation(reason: string): { summary: string; details: string } {
  const text = reason.replace(/^\s*\(AI Generated\)\.?\s*/i, "").trim();
  const [opening, ...details] = text.split(/\n\s*\n/);
  const sentences = opening.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const change =
    /\b(?:activat(?:e[sd]?|ing)|add[sd]?|fix(?:es|ed)?|enabl(?:e[sd]?|ing)|updat(?:e[sd]?|ing)|improv(?:e[sd]?|ing))\b/i;
  const sentence = sentences.find((value) => change.test(value)) ?? sentences[0];
  const clause = sentence.split(/;\s*/).find((value) => change.test(value)) ?? sentence;
  const summary = clause
    .replace(/^this request\b/i, "This restart")
    .replace(/\b[0-9a-f]{40,64}\b/gi, "")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "")
    .replace(/,?\s*version\s+\d+(?:\.\d+)+(?:[-.][\w]+)*/gi, "")
    .replace(/,?\s*source\s*(?=[.,;]|$)/gi, "")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
  return {
    summary,
    details: opening === summary ? details.join("\n\n") : text,
  };
}

export function restartBannerTitle(job: RestartJob): string {
  if (job.factoryRuntimePlanSha256) {
    if (job.status === "running") return "Adopting Factory startup on Dev";
    if (job.finishCurrentTurns) return "Dev finishing turns for Factory adoption";
    if (job.status === "approved") return "Factory startup adoption queued";
    return "Factory startup adoption needs review";
  }
  let target = job.target === "host" ? "Host daemon" : "Dev daemon";
  if (job.supervisorPlanSha256) target = "Dev supervisor";
  if (job.status === "running") {
    return job.update || job.sourceBatch ? `Updating ${target}` : `Restarting ${target}`;
  }
  if (job.finishCurrentTurns) return `${target} finishing current turns`;
  if (job.status === "approved") return `${target} restart queued`;
  if (job.sourceBatch && job.sourceBatch.status !== "ready") {
    const labels = {
      conflict: "update awaiting agent repair",
      preparing: "update is being checked",
      waiting: "update is waiting",
    };
    return `${target} ${labels[job.sourceBatch.status]}`;
  }
  return `${target} restart needs approval`;
}

export function restartBlockingReason(job: RestartJob): string | null {
  if (job.status !== "pending" || job.sourceBatch?.status !== "conflict") return null;
  const reasons = job.sourceBatch.contributions
    .filter((item) => item.status === "invalid" || item.status === "conflict")
    .map((item) => item.detail.split("\n")[0]!);
  return [...new Set(reasons)].join("; ") || job.detail;
}

export function restartRepairGuidance(job: RestartJob): string | null {
  if (!restartBlockingReason(job)) return null;
  return "The requesting agent must repair this update before you can approve it. Leave it queued for repair, or choose Cancel update if you no longer want it. Your running version is unchanged.";
}

export function restartActionDisabledReason(
  job: RestartJob,
  action: "install" | "idle" | "finish",
  busy: boolean,
  supported = true,
): string | null {
  if (busy)
    return "Another installation action is in progress. Wait for it to finish, then try again.";
  if (action !== "install") {
    return supported
      ? null
      : "This restart mode is unavailable because the environment is disconnected or does not support it. Restore its connection or update its restart support, then retry.";
  }
  const blocker = restartBlockingReason(job);
  if (blocker) {
    const remedy = /release notes/i.test(blocker)
      ? "The submitting agent must reconcile the release-note history and resubmit the corrected source. Open Details to identify the blocked contributions."
      : "The submitting agent must resolve the listed source errors and resubmit. Open Details to identify the blocked contributions.";
    return `${restartRepairGuidance(job)} ${remedy}`;
  }
  if (job.sourceBatch?.status === "preparing")
    return "The coordinator is checking and combining the submitted source. Wait for preparation to finish; this button enables when the update is ready.";
  if (job.sourceBatch?.status === "waiting")
    return "This update is waiting for an earlier installation. Let that installation finish or cancel it in Installation controls, then review this request.";
  if (!job.update)
    return "No validated installation artifact is ready. The submitting agent must finish preparation and resubmit the update.";
  return null;
}

export function restartRequestSummary(job: RestartJob): string {
  const dev = job.sourceBatch?.contributions.find(
    (item) => item.status !== "superseded" && item.requestedBy === "container-agent",
  );
  const reason = restartExplanation(dev?.reason ?? job.reason).summary;
  if (dev || job.requestedBy === "container-agent") {
    const origin =
      dev && job.requestedBy !== "container-agent"
        ? "Includes a Dev container request"
        : "Requested by a Dev container";
    const review = job.status === "pending" ? "; your approval is required" : "";
    return `${origin}${review}. ${reason}`;
  }
  if (job.automaticApproval) return `Automatically approved for a trusted Host thread. ${reason}`;
  return reason;
}
