import type { PreviewMonitorJob } from "@getpaseo/protocol/preview-monitor-maintenance";
import type {
  InstallationEnrollmentStatus,
  InstallationRecoveryAccessStatus,
} from "@getpaseo/protocol/installation-enrollment";
import type {
  MaintenanceServiceQueueStatus,
  MaintenanceServiceView,
} from "@getpaseo/protocol/maintenance-service-status";
import { monitorActionDisabledReason, type MonitorAction } from "./preview-monitor-review";
import type { NativeHelperJob } from "@getpaseo/protocol/native-helper-maintenance";
import type { InstructionRequestQuery } from "@getpaseo/protocol/instruction-requests";

type InstructionRequest = InstructionRequestQuery["requests"][number];
import { helperActionDisabledReason, type HelperReviewAction } from "./helper-review";
import type {
  SessionHostJob,
  SessionHostOperation,
} from "@getpaseo/protocol/session-host-maintenance";
import {
  sessionHostActionDisabledReason,
  sessionHostRequestDisabledReason,
  type SessionHostAction,
  type SessionHostOverview,
} from "./session-host-review";
import type {
  DaemonAutomationPreference,
  MaintenanceService,
  InstallationMaintenanceStatus,
  ProfileSharingStatus,
  RestartJob,
  RestartDecision,
  RestartSummary,
} from "@getpaseo/protocol/execution-installation";
import { OwnerAccessExpired, type InstallationClient } from "./client";
import { toErrorMessage } from "@/utils/error-messages";

interface InstallationPanelState {
  serviceQueue: MaintenanceServiceQueueStatus | null;
  serviceQueueError: string | null;
  serviceQueueRefreshing: boolean;
  recoveryAccess: InstallationRecoveryAccessStatus | null;
  recoveryAccessError: string | null;
  recoveryAccessRefreshing: boolean;
  enrollmentStatus: InstallationEnrollmentStatus | null;
  enrollmentError: string | null;
  enrollmentRefreshing: boolean;
  devRepair: { available: boolean; preparingIds: string[] };
  daemonAutomation: DaemonAutomationPreference | null;
  maintenanceStatus: InstallationMaintenanceStatus | null;
  daemonAutomationError: string | null;
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
  monitorJobs: PreviewMonitorJob[];
  helperError: string | null;
  /** Null hides the session host card: locked, or a coordinator without session host jobs. */
  sessionHost: SessionHostOverview | null;
  sessionHostError: string | null;
  /** Null hides the instruction request card: locked, or a coordinator without the route. */
  instructionRequests: InstructionRequestQuery | null;
  instructionError: string | null;
  pendingJobs: RestartJob[];
  profileSharing: ProfileSharingStatus | null;
  passwordFile: string | null;
  sessionsSupported: boolean;
}

export class InstallationPanelModel {
  private state: InstallationPanelState = {
    serviceQueue: null,
    serviceQueueError: null,
    serviceQueueRefreshing: false,
    recoveryAccess: null,
    recoveryAccessError: null,
    recoveryAccessRefreshing: false,
    enrollmentStatus: null,
    enrollmentError: null,
    enrollmentRefreshing: false,
    devRepair: { available: false, preparingIds: [] },
    daemonAutomation: null,
    maintenanceStatus: null,
    daemonAutomationError: null,
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
    monitorJobs: [],
    helperError: null,
    sessionHost: null,
    sessionHostError: null,
    instructionRequests: null,
    instructionError: null,
    pendingJobs: [],
    profileSharing: null,
    passwordFile: null,
    sessionsSupported: false,
  };
  private listeners = new Set<() => void>();
  private refreshing = false;
  private initialized = false;
  private accessGeneration = 0;
  private automationGeneration = 0;

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
    > &
      Partial<
        Pick<
          InstallationClient,
          | "listMonitors"
          | "decideMonitor"
          | "daemonAutomation"
          | "maintenanceStatus"
          | "enrollmentStatus"
          | "recoveryAccess"
          | "maintenanceServices"
          | "cancelMaintenanceService"
          | "changeDaemonAutomation"
          | "devRepairStatus"
          | "prepareDevRepair"
          | "sessionHost"
          | "requestSessionHost"
          | "decideSessionHost"
          | "listInstructionRequests"
          | "decideInstructionRequest"
        >
      >,
    private readonly options: {
      connectionsRegistered: boolean;
      openRequested?: boolean;
    } = {
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
        monitorJobs: [],
        helperError: null,
        sessionHost: null,
        sessionHostError: null,
        instructionRequests: null,
        instructionError: null,
        pendingJobs: [],
        profileSharing: null,
        daemonAutomation: null,
        maintenanceStatus: null,
        recoveryAccess: null,
        recoveryAccessError: null,
        recoveryAccessRefreshing: false,
        enrollmentStatus: null,
        enrollmentError: null,
        enrollmentRefreshing: false,
        serviceQueue: null,
        serviceQueueError: null,
        serviceQueueRefreshing: false,
        daemonAutomationError: null,
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
  clearPasswordDraft(): void {
    this.publish({ password: "", error: null });
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
    const automationGeneration = this.automationGeneration;
    try {
      const [restartSummary] = await Promise.all([
        this.client.restartSummary(),
        this.refreshEnrollmentStatus(),
        this.refreshRecoveryAccess(),
        this.refreshServiceQueue(),
      ]);
      this.publish({ restartSummary });
      if (!this.state.unlocked) return;
      const [
        jobs,
        profileSharing,
        helperJobs,
        monitorJobs,
        daemonAutomation,
        devRepair,
        maintenanceStatus,
        sessionHost,
        instructionRequests,
      ] = await Promise.all([
        this.client.listRestarts(),
        this.client.profileSharingStatus(),
        this.client.listHelpers(),
        this.client.listMonitors?.() ?? Promise.resolve([]),
        this.client.daemonAutomation?.() ?? Promise.resolve(null),
        this.client.devRepairStatus?.() ?? Promise.resolve({ available: false, preparingIds: [] }),
        this.client.maintenanceStatus?.() ?? Promise.resolve(null),
        this.client.sessionHost?.() ?? Promise.resolve(null),
        // This card never blocks the rest of Installation controls.
        (this.client.listInstructionRequests?.() ?? Promise.resolve(null)).catch(
          (error: unknown) => {
            this.publish({
              instructionError: failureMessage(error, "Instruction requests are unavailable"),
            });
            return this.state.instructionRequests;
          },
        ),
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
        devRepair,
        helperJobs,
        monitorJobs,
        sessionHost,
        instructionRequests,
        pendingJobs: pending,
        profileSharing,
        ...(automationGeneration === this.automationGeneration
          ? { daemonAutomation, maintenanceStatus }
          : {}),
        lastUpdatedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
    }
  }

  refreshServiceQueue = async (): Promise<void> => {
    if (
      !this.state.unlocked ||
      !this.client.maintenanceServices ||
      this.state.serviceQueueRefreshing
    )
      return;
    const generation = this.accessGeneration;
    this.publish({ serviceQueueRefreshing: true });
    try {
      const serviceQueue = await this.client.maintenanceServices();
      if (generation === this.accessGeneration)
        this.publish({ serviceQueue, serviceQueueError: null });
    } catch (error) {
      if (generation !== this.accessGeneration) return;
      if (error instanceof OwnerAccessExpired) this.fail(error);
      else
        this.publish({
          serviceQueueError:
            "Unable to refresh maintenance requests. Refresh before cancelling a request.",
        });
    } finally {
      if (generation === this.accessGeneration) this.publish({ serviceQueueRefreshing: false });
    }
  };

  cancelMaintenanceService = async (job: MaintenanceServiceView): Promise<void> => {
    if (this.state.busy || !this.state.unlocked || !this.client.cancelMaintenanceService) return;
    const current = this.state.serviceQueue?.jobs.find((item) => item.id === job.id);
    if (this.state.serviceQueueError || current?.revision !== job.revision || !current.cancelable) {
      this.publish({
        serviceQueueError: "Maintenance changed. Refresh and review its current receipt.",
      });
      return;
    }
    const generation = this.accessGeneration;
    this.publish({ busy: true, serviceQueueError: null });
    try {
      await this.client.cancelMaintenanceService(job);
      if (generation !== this.accessGeneration) return;
      this.publish({ notice: "Maintenance cancelled before dispatch." });
      await this.refreshServiceQueue();
    } catch (error) {
      if (generation !== this.accessGeneration) return;
      if (error instanceof OwnerAccessExpired) this.fail(error);
      else
        this.publish({
          serviceQueueError: failureMessage(error, "Maintenance cancellation failed."),
        });
    } finally {
      if (generation === this.accessGeneration) this.publish({ busy: false });
    }
  };

  refreshRecoveryAccess = async (): Promise<void> => {
    if (!this.state.unlocked || !this.client.recoveryAccess || this.state.recoveryAccessRefreshing)
      return;
    const generation = this.accessGeneration;
    this.publish({ recoveryAccessRefreshing: true });
    try {
      const status = await this.client.recoveryAccess();
      if (generation === this.accessGeneration)
        this.publish({ recoveryAccess: status, recoveryAccessError: null });
    } catch (error) {
      if (generation !== this.accessGeneration) return;
      if (error instanceof OwnerAccessExpired) this.fail(error);
      else
        this.publish({
          recoveryAccess: null,
          recoveryAccessError: "Unable to verify the recovery bookmark. Refresh to check again.",
        });
    } finally {
      if (generation === this.accessGeneration) this.publish({ recoveryAccessRefreshing: false });
    }
  };

  refreshEnrollmentStatus = async (): Promise<void> => {
    if (!this.state.unlocked || !this.client.enrollmentStatus || this.state.enrollmentRefreshing)
      return;
    const generation = this.accessGeneration;
    this.publish({ enrollmentRefreshing: true });
    try {
      const status = await this.client.enrollmentStatus();
      if (generation !== this.accessGeneration) return;
      this.publish({ enrollmentStatus: status, enrollmentError: null });
    } catch (error) {
      if (generation !== this.accessGeneration) return;
      if (error instanceof OwnerAccessExpired) this.fail(error);
      else
        this.publish({
          enrollmentError:
            "Unable to refresh installation status. Last known observations are retained.",
        });
    } finally {
      if (generation === this.accessGeneration) this.publish({ enrollmentRefreshing: false });
    }
  };

  async changeDaemonAutomation(enabled: boolean, service?: MaintenanceService): Promise<void> {
    const preference = this.state.daemonAutomation;
    if (
      this.state.busy ||
      !this.state.unlocked ||
      !preference ||
      !this.client.changeDaemonAutomation
    )
      return;
    const generation = this.accessGeneration;
    this.automationGeneration++;
    this.publish({
      busy: true,
      error: null,
      daemonAutomationError: null,
      notice: "Saving automatic maintenance preference...",
    });
    try {
      const saved = await this.client.changeDaemonAutomation(preference, enabled, service);
      if (generation !== this.accessGeneration) return;
      this.automationGeneration++;
      this.publish({
        daemonAutomation: saved,
        maintenanceStatus: null,
        notice: "Automatic maintenance preference saved.",
      });
    } catch (error) {
      if (generation !== this.accessGeneration) return;
      this.publish({
        notice: null,
        daemonAutomationError: toErrorMessage(error),
      });
      if (error instanceof OwnerAccessExpired) this.fail(error);
    } finally {
      if (generation === this.accessGeneration) this.publish({ busy: false });
    }
  }

  async decideMonitor(job: PreviewMonitorJob, action: MonitorAction): Promise<void> {
    const current = this.state.monitorJobs.find((item) => item.id === job.id);
    if (!current || current.revision !== job.revision || current.planSha256 !== job.planSha256) {
      this.publish({
        helperError: "Monitor request changed. Refresh and review its current bytes.",
      });
      return;
    }
    const reason = monitorActionDisabledReason(current, action, this.state);
    if (reason) {
      this.publish({ helperError: reason });
      return;
    }
    if (!this.client.decideMonitor) {
      this.publish({ helperError: "Monitor controls unavailable" });
      return;
    }
    this.publish({ busy: true, helperError: null });
    try {
      const result = await this.client.decideMonitor(current, action);
      this.publish({
        monitorJobs: this.state.monitorJobs.map((item) => (item.id === result.id ? result : item)),
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
      this.publish({
        error: null,
        helperError: failureMessage(
          error,
          "Monitor decision unconfirmed. Refresh before retrying.",
        ),
      });
    } finally {
      this.publish({ busy: false });
    }
  }
  dismissHelperError(): void {
    this.publish({ helperError: null });
  }

  dismissSessionHostError = (): void => {
    this.publish({ sessionHostError: null });
  };

  /** Creates an owner request; it only prepares a plan, which still needs its own approval. */
  async requestSessionHost(operation: SessionHostOperation): Promise<void> {
    const overview = this.state.sessionHost;
    if (!overview || !this.client.requestSessionHost) return;
    const reason = sessionHostRequestDisabledReason(operation, overview, this.state);
    if (reason) {
      this.publish({ sessionHostError: reason });
      return;
    }
    this.publish({ busy: true, sessionHostError: null });
    try {
      const job = await this.client.requestSessionHost(
        operation,
        "Requested by the owner from Installation controls.",
      );
      this.publish({ sessionHost: { ...overview, jobs: [...overview.jobs, job] } });
      await this.refresh();
    } catch (error) {
      this.failSessionHost(error, "Session host request unconfirmed. Refresh before retrying.");
    } finally {
      this.publish({ busy: false });
    }
  }

  async decideSessionHost(job: SessionHostJob, action: SessionHostAction): Promise<void> {
    if (this.state.busy) return;
    const overview = this.state.sessionHost;
    const current = overview?.jobs.find((item) => item.id === job.id);
    if (
      !overview ||
      !current ||
      current.revision !== job.revision ||
      current.planSha256 !== job.planSha256
    ) {
      this.publish({
        sessionHostError: "Session host request changed. Refresh and review its current plan.",
      });
      return;
    }
    const reason = sessionHostActionDisabledReason(current, action, this.state);
    if (reason || !this.client.decideSessionHost) {
      this.publish({ sessionHostError: reason ?? "Session host controls are unavailable." });
      return;
    }
    this.publish({ busy: true, sessionHostError: null });
    try {
      const result = await this.client.decideSessionHost(current, action);
      this.publish({
        sessionHost: {
          ...overview,
          jobs: overview.jobs.map((item) => (item.id === result.id ? result : item)),
        },
      });
      await this.refresh();
    } catch (error) {
      this.failSessionHost(error, "Session host decision unconfirmed. Refresh before retrying.");
    } finally {
      this.publish({ busy: false });
    }
  }

  private failSessionHost(error: unknown, fallback: string): void {
    this.fail(error);
    // An expired owner session already locked the panel; other failures stay on the card.
    if (!this.state.unlocked) return;
    this.publish({
      error: null,
      sessionHostError: failureMessage(error, fallback),
    });
  }

  dismissInstructionError = (): void => {
    this.publish({ instructionError: null });
  };

  async decideInstructionRequest(
    request: InstructionRequest,
    decision: "approve" | "reject",
  ): Promise<void> {
    if (this.state.busy || !this.client.decideInstructionRequest) return;
    const current = this.state.instructionRequests?.requests.find((item) => item.id === request.id);
    if (!current || current.proposedSha256 !== request.proposedSha256) {
      this.publish({
        instructionError: "Instruction request changed. Refresh and review it again.",
      });
      return;
    }
    this.publish({ busy: true, error: null, instructionError: null, notice: null });
    try {
      const result = await this.client.decideInstructionRequest(current, decision);
      if (result.status === "stale")
        this.publish({ instructionError: result.detail ?? "Instructions changed first." });
      await this.refresh();
    } catch (error) {
      this.publish({
        instructionError: failureMessage(
          error,
          "Instruction decision unconfirmed. Refresh before retrying.",
        ),
      });
    } finally {
      this.publish({ busy: false });
    }
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
        helperError: failureMessage(error, "Helper decision unconfirmed. Refresh before retrying."),
      });
    } finally {
      this.publish({ busy: false });
    }
  }

  async prepareDevRepair(job: RestartJob): Promise<void> {
    if (
      this.state.busy ||
      !this.state.unlocked ||
      !this.state.devRepair.available ||
      this.state.devRepair.preparingIds.includes(job.id) ||
      !this.client.prepareDevRepair
    )
      return;
    const current = this.state.jobs.find((item) => item.id === job.id);
    if (!current || current.revision !== job.revision) {
      this.publish({
        error: "Dev request changed. Refresh before preparing repair.",
      });
      return;
    }
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.prepareDevRepair(current);
      this.publish({
        notice:
          "Dev repair preparation started. Review the resulting source before installation; no restart is approved.",
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
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
    if (error instanceof OwnerAccessExpired) {
      this.accessGeneration++;
      this.publish({
        unlocked: false,
        visible: false,
        busy: false,
        serviceQueue: null,
        serviceQueueError: null,
        serviceQueueRefreshing: false,
        lastUpdatedAt: null,
        password: "",
        jobs: [],
        helperJobs: [],
        monitorJobs: [],
        helperError: null,
        sessionHost: null,
        sessionHostError: null,
        instructionRequests: null,
        instructionError: null,
        pendingJobs: [],
        profileSharing: null,
        daemonAutomation: null,
        maintenanceStatus: null,
        daemonAutomationError: null,
        recoveryAccess: null,
        recoveryAccessError: null,
        recoveryAccessRefreshing: false,
        enrollmentStatus: null,
        enrollmentError: null,
        enrollmentRefreshing: false,
      });
    }
    this.publish({ error: failureMessage(error, "Installation request failed") });
  }
  private publish(update: Partial<InstallationPanelState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
}

export function restartExplanation(reason: string): {
  summary: string;
  details: string;
} {
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

export function restartNoticeVisible(job: RestartJob): boolean {
  if (job.status !== "pending") return true;
  return !job.sourceBatch || job.sourceBatch.status === "ready";
}

/** Pending requests and holds that have not dispatched can still be withdrawn. */
export function restartCancellable(job: RestartJob): boolean {
  if (job.status === "pending") return true;
  return job.status === "approved" && Boolean(job.whenIdle || job.continuationCaptureRequested);
}

/** Tells the owner why a delegated request is back in their queue. */
export function delegationOverdueNote(job: RestartJob): string | null {
  return job.delegationOverdue
    ? `Waiting longer than expected for ${job.delegationOverdue}.`
    : null;
}

export function restartBannerTitle(job: RestartJob): string {
  if (job.delegatedTo) return `Being handled by ${job.delegatedTo}`;
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
  if (job.target === "host")
    return "The requesting agent must repair this update before you can approve it. Leave it queued for repair, or choose Cancel update if you no longer want it. Your running version is unchanged.";
  return "On a compatible coordinator, Prepare Dev repair captures the installed Host source and preserves queued contributions for a new installation review. Otherwise the requesting agent must correct the source. You can cancel the update; your running version is unchanged.";
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
  if (job.automaticApproval) return `Automatically approved by installation policy. ${reason}`;
  return reason;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? toErrorMessage(error) : fallback;
}
