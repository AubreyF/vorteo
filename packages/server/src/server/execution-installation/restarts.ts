import { WorkerLaunchVerifiedCauseSchema } from "@getpaseo/protocol/execution-installation";
import {
  reserveWorkerLaunch,
  progressWorkerLaunch,
  retainedWorkerLaunchForCause,
  workerLaunchRequestCompatible,
} from "./maintenance/worker-launch.js";
import { selectMaintenanceServiceWork } from "./maintenance/service-recovery.js";
import {
  StandingRestartDecisionSchema,
  type StandingRestartDecision,
} from "@getpaseo/protocol/execution-installation";
import {
  PreviewMonitorPreparationSchema,
  PreviewMonitorDecisionSchema,
  type PreviewMonitorJob,
  type PreviewMonitorPlan,
} from "@getpaseo/protocol/preview-monitor-maintenance";
import {
  NativeHelperPreparationSchema,
  NativeHelperRecoveryDecisionSchema,
  NativeHelperInstallerExitSchema,
  NativeHelperProcessIdentitySchema,
  type NativeHelperProcessIdentity,
  type NativeHelperInstallerExit,
  NativeHelperDecisionSchema,
  type NativeHelperJob,
  type NativeHelperPlan,
} from "@getpaseo/protocol/native-helper-maintenance";
import type { LifecycleJob } from "./lifecycle-journal.js";
import {
  MaintenanceServiceJobSchema,
  type MaintenanceServiceJob,
} from "@getpaseo/protocol/maintenance-service";
import type { MaintenanceServiceExecutor } from "./maintenance/service-execution.js";
import {
  isMaintenanceService,
  unresolvedMaintenanceService,
  type MaintenanceServiceAdmissionEvidence,
} from "./maintenance/service-admission.js";
import { isDeepStrictEqual } from "node:util";
import {
  approveServiceJob,
  retainServiceRecoveryObservation,
  reserveServiceJob,
  observeServiceJob,
  serviceInspectionProof,
  serviceCheckDue,
  failedServiceCheck,
} from "./maintenance/service-progress.js";
import type { MaintenanceServiceNativeObservation } from "./maintenance/service-execution.js";
import { createHash, randomUUID } from "node:crypto";
import type { StandingInterruption } from "@getpaseo/protocol/maintenance-interruption";
import type {
  DevRepairCapture,
  RestartImpact,
  RestartDecision,
  RestartJob,
  RestartRequest,
  SourceContribution,
  SourceBatch,
  SourceUpdate,
} from "@getpaseo/protocol/execution-installation";

export interface InstallUpdateOptions {
  /** Replace the whole service, as an owner approve does, after the turns hold settles. */
  serviceRestart: boolean;
}

/** A dispatched restart must verify readiness within this, or it fails without replay. */
const DISPATCH_READINESS_DEADLINE_MS = 10 * 60_000;

export interface RestartStartupOptions {
  fenced: boolean;
  /** Operator-visible progress for each dispatch step; never silent for hours. */
  progress?: (message: string, fields: Record<string, unknown>) => void;
  dispatchDeadlineMs?: number;
}

export interface RestartApprovalPolicy {
  serviceAuthority?: (
    job: MaintenanceServiceJob,
  ) => import("./maintenance/service-admission.js").MaintenanceServiceStandingAuthority | null;
  /** Undefined is verified never-enrolled legacy behavior; null denies enrolled work.
   * Evaluation is policy only. The shared journal must verify each effect admission. */
  standingDecision?: (
    job: RestartJob,
  ) => Omit<StandingRestartDecision, "requestRevision"> | null | undefined;
  /** Binds grants to the installed policy revision and authenticated credential set. */
  authority?: () => string;
  cancellationDelayMs?: number;
  hostRequestsAfter?: string;
  // Undefined retains legacy Host-only policy; null explicitly disables automation.
  daemonRequestsAfter?: (target: RestartJob["target"]) => string | null | undefined;
  /** Controller authority never inherits a daemon or legacy Host grant. */
  supervisorRequestsAfter?: () => string | null;
  /** Owner delegation: automatic Host source updates may replace the supervisor. */
  hostUpdateServiceRestart?: () => boolean;
}

export interface RestartJournal {
  read(): LifecycleJob[];
  mutate?(
    update: (previous: readonly LifecycleJob[]) => LifecycleJob[],
    evidence?: MaintenanceServiceAdmissionEvidence,
  ): void;
  write(jobs: LifecycleJob[], evidence?: MaintenanceServiceAdmissionEvidence): void;
  admissionAvailable?(): boolean;
  activationChildAdmissionAvailable?(job: RestartJob): boolean;
}

export interface RestartExecutor {
  /** The selected coordinator's existing drain owns activation continuation.
   * Unresolved work blocks ordinary discovery/dispatch; this adds no timer. */
  reconcileInitialHostActivation?(): Promise<"idle" | "verified" | "unresolved">;
  /** Read only a single captured protected native cause while the lifecycle lock
   * is held. Absence supplies no root launch authority. */
  resolveWorkerLaunchCause?: (
    hints: NonNullable<RestartRequest["workerLaunchRequest"]>,
  ) => import("@getpaseo/protocol/execution-installation").WorkerLaunchVerifiedCause | null;
  prepareInterruption?(job: RestartJob): Promise<StandingInterruption>;
  restartHeld?(job: RestartJob): Promise<string>;
  /** Read-only verification of the exact candidate/source and old worker exit.
   * Null retains uncertainty; this must remain available after grant revocation. */
  observeInterruption?(job: RestartJob): Promise<string | null>;
  maintenanceServices?: MaintenanceServiceExecutor;
  /** Read-only construction, retried by existing coordinator reconciliation. */
  discoverMaintenanceServices?(): Promise<MaintenanceServiceExecutor>;
  observeMaintenanceServices?: import("./maintenance/status.js").MaintenanceServiceObservationReader;
  observeRecoveryAccess?: import("./maintenance/recovery-access.js").RecoveryAccessReader;
  inspectMonitor?(): Promise<
    import("@getpaseo/protocol/preview-monitor-maintenance").PreviewMonitorSelection
  >;
  monitorCompatible?(): Promise<boolean>;
  validateMonitorPlan?(plan: PreviewMonitorPlan): Promise<void>;
  installMonitor?(job: PreviewMonitorJob): Promise<string>;
  factoryRuntimePlan?(): string | undefined;
  adoptFactoryRuntime?(job: RestartJob): Promise<string>;
  validateHelperRollback?(job: NativeHelperJob, failed: NativeHelperJob): Promise<void>;
  verifyHelperRecovery?(job: NativeHelperJob): Promise<string>;
  validateHelperPlan?(plan: NativeHelperPlan): Promise<void>;
  installHelper?(
    job: NativeHelperJob,
    reportPhase: (stage: "installing" | "verifying") => void,
    recordInstaller: (pid: number) => void,
    recordInstallerExit: (exit: NativeHelperInstallerExit) => void,
    recordPrevious: (previous: NativeHelperProcessIdentity | null) => void,
  ): Promise<string>;
  supervisorPlan?(): string | undefined;
  restartSupervisor?(job: RestartJob): Promise<string>;
  supportsUpdate?(target: RestartJob["target"]): boolean;
  sourceBase?(target: RestartJob["target"]): string;
  sourceWeb?(target: RestartJob["target"]): string;
  prepareUpdate?(
    contributions: SourceContribution[],
    target: RestartJob["target"],
  ): Promise<{ batch: SourceBatch; update?: SourceUpdate }>;
  captureDevRepair?(contributions: SourceContribution[]): DevRepairCapture;
  prepareDevRepair?(
    capture: DevRepairCapture,
    contributions: SourceContribution[],
  ): Promise<SourceUpdate>;
  prepareInstallation?(job: RestartJob): Promise<void>;
  verifyPreparedInstallation?(job: RestartJob, options?: { signal?: AbortSignal }): Promise<void>;
  /** Final independent evidence after the locked running reservation. */
  verifyDispatch?(job: RestartJob): Promise<void>;
  installUpdate?(job: RestartJob, options: InstallUpdateOptions): Promise<string>;
  restart(target: RestartJob["target"]): Promise<string>;
  inspect?(target: RestartJob["target"]): Promise<RestartImpact>;
  restartWhenIdle?(target: RestartJob["target"]): Promise<string | null>;
  holdCurrentTurns?(target: RestartJob["target"], requestId: string): Promise<void>;
  /** Independently inspected process birth and boot identity, only for initial migration. */
  initialActivationInstance?(job: RestartJob): Promise<string>;
  releaseCurrentTurns?(target: RestartJob["target"], requestId: string): Promise<void>;
  /** False when the target cannot hold durable continuation, e.g. an older daemon. */
  restartContinuationAvailable?(target: RestartJob["target"]): Promise<boolean>;
  captureRestartContinuation?(target: RestartJob["target"], requestId: string): Promise<void>;
  releaseRestartContinuation?(
    target: RestartJob["target"],
    requestId: string,
    outcome: "ready" | "cancelled",
  ): Promise<boolean>;
}

export function supportsAutomaticMaintenance(executor: RestartExecutor): boolean {
  return Boolean(
    executor.inspect &&
    executor.holdCurrentTurns &&
    executor.releaseCurrentTurns &&
    executor.restartWhenIdle,
  );
}

export class RestartRequestError extends Error {}

function validateSourceDecision(job: RestartJob, decision: RestartDecision, updateSha256?: string) {
  if ((job.update || job.sourceBatch) && decision !== "reject" && decision !== "cancel") {
    if (decision !== "approve" || !job.update || updateSha256 !== job.update.sha256)
      throw new RestartRequestError(
        "Review and approve this exact source update. Idle updates are not supported.",
      );
  }
}

/** The coordinator owns this queue, so daemon restarts cannot destroy the receipt. */
function requestPredatesPolicy(
  job: RestartJob,
  threshold: number,
  standing: Omit<StandingRestartDecision, "requestRevision"> | null | undefined,
): boolean {
  return Date.parse(job.createdAt) < threshold && !standing?.activationStep;
}

export class InstallationRestarts {
  private readonly progress: NonNullable<RestartStartupOptions["progress"]>;
  private readonly dispatchDeadlineMs: number;
  private jobs: RestartJob[];
  private helpers: NativeHelperJob[];
  private monitors: PreviewMonitorJob[];
  private snapshot: LifecycleJob[];
  private active = false;
  private running = false;
  private readonly candidateChecks = new Map<string, AbortController>();
  private refreshingImpacts = false;
  private preparing = false;
  private readonly impactCache = new Map<RestartJob["target"], RestartImpact>();

  constructor(
    private readonly journal: RestartJournal,
    private readonly executor: RestartExecutor,
    private readonly now: () => number = Date.now,
    private readonly approvalPolicy: RestartApprovalPolicy = {},
    startup: RestartStartupOptions = { fenced: false },
  ) {
    this.progress = startup.progress ?? (() => {});
    this.dispatchDeadlineMs = startup.dispatchDeadlineMs ?? DISPATCH_READINESS_DEADLINE_MS;
    this.snapshot = journal.read();
    this.jobs = this.snapshot.filter(
      (job): job is RestartJob => job.target === "host" || job.target === "container-daemon",
    );
    this.helpers = this.snapshot.filter(
      (job): job is NativeHelperJob => job.target === "native-helper",
    );
    this.monitors = this.snapshot.filter(
      (job): job is PreviewMonitorJob => job.target === "preview-monitor",
    );
    if (!startup.fenced) this.activate();
  }

  private loadState(): void {
    this.snapshot = this.journal.read();
    this.jobs = this.snapshot.filter(
      (job): job is RestartJob => job.target === "host" || job.target === "container-daemon",
    );
    this.helpers = this.snapshot.filter(
      (job): job is NativeHelperJob => job.target === "native-helper",
    );
    this.monitors = this.snapshot.filter(
      (job): job is PreviewMonitorJob => job.target === "preview-monitor",
    );
  }

  /** Only the verified coordinator handoff releases this startup fence. */
  activate(): void {
    if (this.active) return;
    if (JSON.stringify(this.journal.read()) !== JSON.stringify(this.snapshot))
      throw new RestartRequestError("Restart journal changed while startup was fenced");
    // A coordinator crash leaves execution ambiguous. Never replay a disruptive action.
    const recovered = this.jobs.map((job): RestartJob => {
      if ((job.standingInterruption || job.workerLaunch) && job.status === "running") return job;
      if (job.status === "pending" && job.devRepairs?.at(-1)?.status === "preparing") {
        return {
          ...job,
          revision: randomUUID(),
          devRepairs: job.devRepairs.map((attempt) =>
            attempt.status === "preparing"
              ? {
                  ...attempt,
                  status: "failed" as const,
                  detail: "Preparation interrupted. Capture a new repair.",
                }
              : attempt,
          ),
          detail:
            "Dev repair preparation interrupted. Capture a new repair; no restart was approved.",
        };
      }
      // Retry inert validation once after a coordinator upgrade. Never carry an
      // approval into a recomputed batch or replay dispatched installation work.
      if (job.status === "pending" && job.sourceBatch?.status === "conflict") {
        return {
          ...job,
          revision: randomUUID(),
          update: undefined,
          sourceBatch: { ...job.sourceBatch, status: "preparing" as const },
          detail: "Rechecking source contributions",
        };
      }
      if (job.status === "approved" && job.updatePreparation === "preparing")
        return {
          ...job,
          status: "failed",
          detail:
            "Source preparation interrupted before activation. Prepare a new update; the running release was not changed.",
        };
      if (job.status === "approved" && job.whenIdle) return job;
      if (job.status !== "running" && job.status !== "approved") return job;
      return {
        ...job,
        ...(job.status === "running" && job.factoryRuntimePlanSha256
          ? { factoryRuntimeRecoveryRequired: true }
          : {}),
        status: "failed",
        detail: "Coordinator interrupted. Inspect target and request a new restart.",
      };
    });
    const helpers = this.helpers.map((job): NativeHelperJob => {
      if (["approved", "running"].includes(job.status))
        return {
          ...job,
          status: "failed",
          stage: "recovery_required",
          detail: "Coordinator interrupted. Inspect helper selection before preparing recovery.",
        };
      if (job.stage === "preparing" && job.status === "pending")
        return {
          ...job,
          status: "failed",
          detail: "Preparation interrupted. Prepare a new helper request.",
        };
      return job;
    });
    const monitors = this.monitors.map((job): PreviewMonitorJob => {
      if (job.status === "approved" || job.status === "running")
        return {
          ...job,
          status: "failed",
          stage: "recovery_required",
          detail:
            "Coordinator interrupted. Inspect retained monitor receipt; never replay or roll back automatically.",
        };
      if (job.status === "pending" && job.stage === "preparing")
        return {
          ...job,
          status: "failed",
          detail: "Preparation interrupted. Prepare a new monitor request.",
        };
      return job;
    });
    this.writeState(recovered, helpers, monitors);
    this.active = true;
    this.reconcilePending();
  }

  private requireActive(): void {
    if (!this.active)
      throw new RestartRequestError("Coordinator startup is fenced for maintenance");
  }

  list(): RestartJob[] {
    this.reconcilePending();
    return structuredClone(
      this.jobs.map((job) => ({ ...job, impact: this.impactCache.get(job.target) })),
    );
  }

  serviceMaintenanceAvailable(): boolean {
    return Boolean(
      this.executor.maintenanceServices &&
      this.journal.mutate &&
      this.approvalPolicy.serviceAuthority,
    );
  }

  serviceMaintenanceOperations(): MaintenanceServiceJob["operation"][] {
    if (!this.serviceMaintenanceAvailable()) return [];
    return [...new Set(this.executor.maintenanceServices!.operations ?? ["replacement" as const])];
  }

  private hasServiceWork(): boolean {
    return (
      this.serviceMaintenanceAvailable() &&
      this.listServices().some((job) => ["pending", "approved", "running"].includes(job.status))
    );
  }

  requestService(
    proposal: unknown,
    reason: string,
    requestedBy: string,
    requester?: string,
  ): MaintenanceServiceJob {
    this.requireActive();
    if (!this.serviceMaintenanceAvailable())
      throw new RestartRequestError("Native maintenance is unavailable");
    const job = MaintenanceServiceJobSchema.parse({
      id: (proposal as { id?: unknown })?.id,
      revision: randomUUID(),
      target: (proposal as { target?: unknown })?.target,
      operation: (proposal as { operation?: unknown })?.operation,
      proposal,
      reason,
      requester,
      createdAt: new Date(this.now()).toISOString(),
      status: "pending",
      detail: "Native maintenance requested. Verifying source and standing authority.",
      evidence: [],
    });
    if (
      job.proposal.requestedBy !== requestedBy ||
      !this.serviceMaintenanceOperations().includes(job.operation) ||
      (job.operation === "replacement") === Boolean(job.proposal.recoveryOf)
    )
      throw new RestartRequestError(
        "Native maintenance requester or supported operation does not match",
      );
    this.journal.mutate!((previous) => {
      const retained = previous.find((item) => item.id === job.id);
      if (retained) {
        if (
          !isMaintenanceService(retained) ||
          !isDeepStrictEqual(retained.proposal, job.proposal) ||
          retained.reason !== reason ||
          retained.requester !== requester
        )
          throw new RestartRequestError("Request identity belongs to different maintenance");
        return [...previous];
      }
      return [...previous, job];
    });
    return structuredClone(this.listServices().find((item) => item.id === job.id)!);
  }

  cancelService(id: string, revision: string): MaintenanceServiceJob {
    this.requireActive();
    const job = this.listServices().find((item) => item.id === id);
    if (
      !job ||
      job.revision !== revision ||
      !["pending", "approved"].includes(job.status) ||
      job.reservation
    )
      throw new RestartRequestError("Maintenance changed or was already dispatched");
    const next = {
      ...job,
      revision: randomUUID(),
      status: "rejected" as const,
      detail: "Maintenance cancelled before dispatch.",
    };
    this.replaceService(job, next);
    return structuredClone(next);
  }

  listMonitors(): PreviewMonitorJob[] {
    return structuredClone(this.monitors);
  }

  private replaceMonitor(next: PreviewMonitorJob): void {
    this.requireActive();
    this.writeState(
      this.jobs,
      this.helpers,
      this.monitors.some((job) => job.id === next.id)
        ? this.monitors.map((job) => (job.id === next.id ? next : job))
        : [...this.monitors, next],
    );
  }

  async prepareMonitor(input: unknown, requestedBy: string): Promise<PreviewMonitorJob> {
    this.requireActive();
    if (requestedBy !== "host-agent")
      throw new RestartRequestError("Monitor preparation requires Host access");
    if (
      !this.executor.validateMonitorPlan ||
      !this.executor.installMonitor ||
      !(await this.executor.monitorCompatible?.())
    )
      throw new RestartRequestError(
        "Monitor maintenance requires compatible selected and recovery coordinators",
      );
    const prepared = PreviewMonitorPreparationSchema.parse(input);
    const planSha256 = createHash("sha256").update(JSON.stringify(prepared.plan)).digest("hex");
    const existing = this.snapshot.find((job) => job.id === prepared.id);
    if (existing) {
      if (
        existing.target !== "preview-monitor" ||
        existing.planSha256 !== planSha256 ||
        existing.reason !== prepared.reason
      )
        throw new RestartRequestError("Request identity belongs to different work");
      return structuredClone(existing);
    }
    const job: PreviewMonitorJob = {
      ...prepared,
      target: "preview-monitor",
      operation: prepared.plan.operation,
      revision: randomUUID(),
      requestedBy: "host-agent",
      createdAt: new Date(this.now()).toISOString(),
      planSha256,
      status: "pending",
      stage: "preparing",
      detail: "Verifying reviewed monitor bytes and selected ancestry",
    };
    this.replaceMonitor(job);
    try {
      await this.executor.validateMonitorPlan(structuredClone(job.plan));
      if (this.monitors.find((item) => item.id === job.id)?.status === "pending")
        this.replaceMonitor({
          ...job,
          stage: "prepared",
          detail: "Review this exact monitor replacement. Host and Dev agents keep running.",
        });
    } catch {
      if (this.monitors.find((item) => item.id === job.id)?.status === "pending")
        this.replaceMonitor({
          ...job,
          status: "failed",
          detail: "Monitor preparation failed. Inspect artifacts and prepare a new request.",
        });
    }
    return this.listMonitors().find((item) => item.id === job.id)!;
  }

  decideMonitor(input: unknown): PreviewMonitorJob {
    this.requireActive();
    const decision = PreviewMonitorDecisionSchema.parse(input);
    const job = this.monitors.find((item) => item.id === decision.id);
    if (
      !job ||
      job.revision !== decision.revision ||
      job.planSha256 !== decision.planSha256 ||
      createHash("sha256").update(JSON.stringify(job.plan)).digest("hex") !== job.planSha256
    )
      throw new RestartRequestError(
        "Monitor request changed. Review its exact revision and bytes.",
      );
    if (decision.decision === "cancel") {
      if (!["pending", "approved"].includes(job.status))
        throw new RestartRequestError("Monitor request already dispatched or decided");
      this.replaceMonitor({
        ...job,
        status: "rejected",
        detail: "Monitor replacement canceled",
      });
    } else {
      if (job.status !== "pending" || job.stage !== "prepared")
        throw new RestartRequestError("Monitor is not ready for approval");
      this.replaceMonitor({
        ...job,
        status: "approved",
        approvedAt: new Date(this.now()).toISOString(),
        detail: "Exact monitor replacement approved",
      });
    }
    return this.listMonitors().find((item) => item.id === job.id)!;
  }

  private monitorRecoveryRequired(): boolean {
    return this.monitors.some(
      (job) => job.status === "running" || job.stage === "recovery_required",
    );
  }

  private async dispatchMonitor(job: PreviewMonitorJob): Promise<void> {
    try {
      if (
        !this.executor.validateMonitorPlan ||
        !this.executor.installMonitor ||
        !(await this.executor.monitorCompatible?.())
      )
        throw new Error("Monitor execution unavailable");
      if (createHash("sha256").update(JSON.stringify(job.plan)).digest("hex") !== job.planSha256)
        throw new Error("Monitor plan changed");
      await this.executor.validateMonitorPlan(structuredClone(job.plan));
      const current = this.monitors.find((item) => item.id === job.id);
      if (current?.status !== "approved" || current.revision !== job.revision) return;
      const dispatched: PreviewMonitorJob = {
        ...current,
        status: "running",
        stage: "dispatch_pending",
        detail: "Replacing approved monitor and verifying selected pathname",
      };
      this.replaceMonitor(dispatched); // Durable dispatch intent before any write.
      const detail = await this.executor.installMonitor(structuredClone(dispatched));
      this.replaceMonitor({
        ...dispatched,
        status: "succeeded",
        stage: "succeeded",
        detail,
      });
    } catch {
      const current = this.monitors.find((item) => item.id === job.id)!;
      if (current.status === "rejected") return;
      this.replaceMonitor({
        ...current,
        status: "failed",
        stage: current.status === "running" ? "recovery_required" : "prepared",
        detail:
          current.status === "running"
            ? "Monitor outcome is uncertain. Inspect retained bytes and receipt. Never replay or roll back automatically."
            : "Monitor validation failed before dispatch. Prepare a new request.",
      });
    }
  }

  listHelpers(): NativeHelperJob[] {
    return structuredClone(this.helpers);
  }

  async prepareHelper(input: unknown, requestedBy: string): Promise<NativeHelperJob> {
    this.requireActive();
    if (requestedBy !== "host-agent")
      throw new RestartRequestError("Helper preparation requires Host access");
    if (!this.executor.validateHelperPlan || !this.executor.installHelper)
      throw new RestartRequestError("Helper installation is unavailable");
    const prepared = NativeHelperPreparationSchema.parse(input);
    const planSha256 = createHash("sha256").update(JSON.stringify(prepared.plan)).digest("hex");
    const existing = this.snapshot.find((job) => job.id === prepared.id);
    if (existing) {
      if (
        existing.target !== "native-helper" ||
        existing.planSha256 !== planSha256 ||
        existing.reason !== prepared.reason
      )
        throw new RestartRequestError("Request identity already belongs to different work");
      return structuredClone(existing);
    }
    const job: NativeHelperJob = {
      ...prepared,
      target: "native-helper",
      operation: prepared.plan.operation,
      revision: randomUUID(),
      requestedBy: "host-agent",
      createdAt: new Date(this.now()).toISOString(),
      planSha256,
      status: "pending",
      stage: "preparing",
      detail: "Verifying the prepared helper artifact",
    };
    this.replaceHelper(job);
    try {
      await this.executor.validateHelperPlan(structuredClone(job.plan));
      const current = this.helpers.find((item) => item.id === job.id);
      if (current?.status === "pending" && current.revision === job.revision)
        this.replaceHelper({
          ...job,
          stage: "prepared",
          detail: "Review this exact helper installation. Agent daemons stay running.",
        });
    } catch {
      const current = this.helpers.find((item) => item.id === job.id);
      if (current?.status === "pending" && current.revision === job.revision)
        this.replaceHelper({
          ...job,
          status: "failed",
          detail: "Helper preparation failed. Inspect the artifact and prepare a new request.",
        });
    }
    return structuredClone(this.helpers.find((item) => item.id === job.id)!);
  }

  decideHelper(input: unknown): NativeHelperJob {
    this.requireActive();
    const decision = NativeHelperDecisionSchema.parse(input);
    const job = this.helpers.find((item) => item.id === decision.id);
    if (
      !job ||
      job.revision !== decision.revision ||
      job.planSha256 !== decision.planSha256 ||
      job.operation !== decision.operation
    )
      throw new RestartRequestError("Helper request changed. Review the exact prepared artifact.");
    if (decision.decision === "cancel") {
      if (!["pending", "approved"].includes(job.status))
        throw new RestartRequestError("Helper operation already dispatched or decided");
      this.replaceHelper({ ...job, status: "rejected", detail: "Helper installation canceled" });
    } else {
      this.assertHelperPlanUnchanged(job);
      if (job.status !== "pending" || job.stage !== "prepared")
        throw new RestartRequestError("Helper request is not ready for approval");
      this.replaceHelper({
        ...job,
        status: "approved",
        approvedAt: new Date(this.now()).toISOString(),
        detail: "Helper installation approved",
      });
    }
    return structuredClone(this.helpers.find((item) => item.id === job.id)!);
  }

  /** Owner-authenticated read-only recovery; never dispatches another install. */
  async verifyHelperRecovery(input: unknown): Promise<NativeHelperJob> {
    this.requireActive();
    const decision = NativeHelperRecoveryDecisionSchema.parse(input);
    if (this.running || this.preparing)
      throw new RestartRequestError("Another lifecycle operation is active");
    if (!this.executor.verifyHelperRecovery)
      throw new RestartRequestError("Helper recovery verification is unavailable");
    const job = this.helpers.find((item) => item.id === decision.id);
    if (
      !job ||
      job.revision !== decision.revision ||
      job.planSha256 !== decision.planSha256 ||
      job.status !== "failed" ||
      job.stage !== "recovery_required"
    )
      throw new RestartRequestError("Recovery request changed. Inspect the current receipt.");
    this.assertHelperPlanUnchanged(job);
    if (
      this.helpers.some(
        (candidate) =>
          (candidate.stage === "recovery_required" || candidate.status === "running") &&
          candidate.plan.recoveryOf?.id === job.id,
      )
    )
      throw new RestartRequestError(
        "Verify the latest failed recovery before its earlier requests",
      );
    const linked = this.recoveryChain(job);
    const before = JSON.stringify(job);
    this.running = true;
    try {
      const detail = await this.executor.verifyHelperRecovery(structuredClone(job));
      const current = this.helpers.find((item) => item.id === job.id);
      if (!current || JSON.stringify(current) !== before)
        throw new RestartRequestError("Helper receipt changed during recovery verification");
      this.recoveryChain(job);
      const recovered: NativeHelperJob = {
        ...current,
        stage: "recovered",
        recoveryVerifiedAt: new Date(this.now()).toISOString(),
        detail,
      };
      this.writeState(
        this.jobs,
        this.helpers.map((item) => {
          if (item.id === recovered.id) return recovered;
          if (linked.some((failed) => item.id === failed.id))
            return {
              ...item,
              stage: "recovered",
              recoveredBy: recovered.id,
              recoveryVerifiedAt: recovered.recoveryVerifiedAt,
              detail: "Recovered by the verified separately approved helper rollback.",
            };
          return item;
        }),
      );
      return structuredClone(this.helpers.find((item) => item.id === job.id)!);
    } finally {
      this.running = false;
    }
  }

  private replaceHelper(next: NativeHelperJob): void {
    this.requireActive();
    const exists = this.helpers.some((job) => job.id === next.id);
    this.writeState(
      this.jobs,
      exists
        ? this.helpers.map((job) => (job.id === next.id ? next : job))
        : [...this.helpers, next],
    );
  }

  private assertHelperPlanUnchanged(job: NativeHelperJob): void {
    const digest = createHash("sha256").update(JSON.stringify(job.plan)).digest("hex");
    if (digest !== job.planSha256 || job.operation !== job.plan.operation)
      throw new RestartRequestError("Helper plan changed. Prepare and review a new request.");
  }

  private helperRecoveryRequired(): boolean {
    return this.helpers.some(
      (job) => job.stage === "recovery_required" || job.status === "running",
    );
  }

  private linkedRecovery(job: NativeHelperJob): NativeHelperJob | undefined {
    const reference = job.plan.recoveryOf;
    if (!reference) return undefined;
    const failed = this.helpers.find((item) => item.id === reference.id);
    if (
      job.operation !== "native-helper-rollback" ||
      !failed ||
      failed.status !== "failed" ||
      failed.stage !== "recovery_required" ||
      failed.revision !== reference.revision ||
      failed.planSha256 !== reference.planSha256 ||
      failed.plan.installationId !== job.plan.installationId ||
      failed.plan.destination.application !== job.plan.destination.application ||
      failed.plan.destination.runtime !== job.plan.destination.runtime ||
      !failed.plan.previous ||
      job.plan.candidate.artifactSha256 !== failed.plan.previous.artifactSha256 ||
      job.plan.candidate.sourceCommit !== failed.plan.previous.sourceCommit
    )
      throw new RestartRequestError(
        "Rollback must restore the exact failed request's retained release",
      );
    this.assertHelperPlanUnchanged(failed);
    return failed;
  }

  private recoveryChain(job: NativeHelperJob): NativeHelperJob[] {
    const chain: NativeHelperJob[] = [];
    const seen = new Set([job.id]);
    let failed = this.linkedRecovery(job);
    while (failed) {
      if (seen.has(failed.id))
        throw new RestartRequestError("Helper recovery references form a cycle");
      seen.add(failed.id);
      chain.push(failed);
      failed = this.linkedRecovery(failed);
    }
    return chain;
  }

  private async dispatchHelper(job: NativeHelperJob): Promise<void> {
    if (!this.executor.validateHelperPlan || !this.executor.installHelper) return;
    try {
      this.assertHelperPlanUnchanged(job);
      const chain = this.recoveryChain(job);
      if (
        this.helpers.some(
          (item) =>
            (item.stage === "recovery_required" || item.status === "running") &&
            !chain.some((failed) => failed.id === item.id),
        )
      )
        throw new RestartRequestError("Another helper failure requires separate recovery");
      const failed = chain[0];
      if (failed) {
        if (!this.executor.validateHelperRollback)
          throw new RestartRequestError("Interrupted helper rollback is unavailable");
        await this.executor.validateHelperRollback(structuredClone(job), structuredClone(failed));
        this.linkedRecovery(job);
      }
      await this.executor.validateHelperPlan(structuredClone(job.plan));
      const current = this.helpers.find((item) => item.id === job.id);
      if (current?.status !== "approved" || current.revision !== job.revision) return;
      const dispatched: NativeHelperJob = {
        ...job,
        status: "running",
        stage: "dispatch_pending",
        detail: "Installing the approved native helper",
      };
      this.replaceHelper(dispatched);
      const detail = await this.executor.installHelper(
        structuredClone(dispatched),
        (stage) => {
          const executing = this.helpers.find((item) => item.id === job.id);
          if (executing?.status !== "running" || executing.revision !== job.revision)
            throw new RestartRequestError("Helper execution no longer owns its journal request");
          if (executing.stage === "verifying" && stage === "installing")
            throw new RestartRequestError(
              "Helper execution cannot return to installation after verification",
            );
          this.replaceHelper({
            ...executing,
            stage,
            detail:
              stage === "installing"
                ? "Installing the approved native helper"
                : "Verifying the installed native helper",
          });
        },
        (installerPid) => {
          const executing = this.helpers.find((item) => item.id === job.id);
          if (
            executing?.status !== "running" ||
            executing.revision !== job.revision ||
            executing.installerPid !== undefined ||
            !Number.isInteger(installerPid) ||
            installerPid <= 0 ||
            installerPid > 2147483647
          )
            throw new RestartRequestError("Helper installer process cannot claim this request");
          this.replaceHelper({ ...executing, installerPid });
        },
        (exit) => {
          const observed = this.helpers.find((item) => item.id === job.id);
          if (
            !observed ||
            observed.revision !== job.revision ||
            observed.installerPid === undefined ||
            observed.installerExit !== undefined ||
            !(observed.status === "running" || observed.stage === "recovery_required")
          )
            throw new RestartRequestError("Installer exit no longer belongs to this request");
          this.replaceHelper({
            ...observed,
            installerExit: NativeHelperInstallerExitSchema.parse(exit),
          });
        },
        (previous) => {
          const observed = this.helpers.find((item) => item.id === job.id);
          if (
            observed?.status !== "running" ||
            observed.stage !== "dispatch_pending" ||
            observed.revision !== job.revision ||
            observed.previousProcess !== undefined ||
            observed.installerPid !== undefined
          )
            throw new RestartRequestError(
              "Previous helper identity must be recorded before installation",
            );
          this.replaceHelper({
            ...observed,
            previousProcess: NativeHelperProcessIdentitySchema.nullable().parse(previous),
          });
        },
      );
      const completed: NativeHelperJob = {
        ...this.helpers.find((item) => item.id === job.id)!,
        status: "succeeded",
        stage: "succeeded",
        detail,
      };
      // Persist both outcomes together; a failed write must retain the fence.
      this.writeState(
        this.jobs,
        this.helpers.map((item) => {
          if (item.id === completed.id) return completed;
          if (chain.some((ancestor) => item.id === ancestor.id))
            return {
              ...item,
              stage: "recovered",
              recoveredBy: completed.id,
              recoveryVerifiedAt: new Date(this.now()).toISOString(),
              detail: "Recovered by the separately approved helper rollback.",
            };
          return item;
        }),
      );
    } catch {
      const current = this.helpers.find((item) => item.id === job.id);
      if (!current || !["approved", "running"].includes(current.status)) return;
      this.replaceHelper({
        ...current,
        status: "failed",
        stage: current.status === "running" ? "recovery_required" : "prepared",
        detail: "Helper installation failed. Inspect the actual selection before recovery.",
      });
    }
  }

  private validateOwnerApprovalOrigin(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
  ) {
    if (!input.requireOwnerApproval) return;
    if (requestedBy !== "host-agent")
      throw new RestartRequestError("Explicit owner approval requires trusted Host provenance");
    if (input.factoryRuntimePlanSha256 || input.factoryRuntimeRecoveryOf)
      throw new RestartRequestError("Factory adoption already requires exact owner review");
  }

  private sharePlainRequest(active: RestartJob, requireOwnerApproval: boolean): RestartJob {
    if (requireOwnerApproval && (!active.requireOwnerApproval || active.automaticApproval)) {
      if (active.status !== "pending")
        throw new RestartRequestError(
          "An approved request cannot gain an owner-review requirement. Cancel it or wait for its result before submitting a new request.",
        );
      const reviewed = { ...active, requireOwnerApproval: true, revision: randomUUID() };
      this.replace(reviewed);
      return { ...reviewed };
    }
    return { ...active };
  }

  request(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): RestartJob {
    if (input.workerLaunchRequest) return this.requestWorkerLaunch(input, requestedBy, update);
    return this.requestRestart(input, requestedBy, update);
  }

  private requestWorkerLaunch(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): RestartJob {
    this.requireActive();
    if (requestedBy !== "container-agent" || !workerLaunchRequestCompatible({ ...input, update }))
      throw new RestartRequestError("Worker launch requires a separate Dev requester scope");
    this.validateOwnerApprovalOrigin(input, requestedBy);
    if (!this.journal.mutate)
      throw new RestartRequestError("Atomic lifecycle journal is unavailable");
    let retained: RestartJob | undefined;
    this.journal.mutate((previous) => {
      const verified = this.executor.resolveWorkerLaunchCause?.(input.workerLaunchRequest!);
      if (verified)
        retained = retainedWorkerLaunchForCause(
          previous,
          WorkerLaunchVerifiedCauseSchema.parse(verified),
        );
      if (!verified)
        retained = previous.find(
          (job): job is RestartJob =>
            (job.target === "host" || job.target === "container-daemon") &&
            !job.workerLaunch &&
            Boolean(job.workerLaunchRequest) &&
            isDeepStrictEqual(job.workerLaunchRequest, input.workerLaunchRequest),
        );
      if (retained) return [...previous];
      if (
        previous.some(
          (job) =>
            (job.target === "host" || job.target === "container-daemon") &&
            this.conflictsWithRequest(job, input),
        )
      )
        throw new RestartRequestError("Worker launch cannot share an ordinary restart approval");
      retained = {
        ...this.newRequest(input, requestedBy),
        detail: "Protected Linux worker launch capability is unavailable; no effect dispatched.",
      };
      return [...previous, retained];
    });
    this.loadState();
    return structuredClone(retained!);
  }

  private requestRestart(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): RestartJob {
    this.requireActive();
    this.validateOwnerApprovalOrigin(input, requestedBy);
    this.validateSupervisorRequest(input, requestedBy, update);
    this.validateFactoryRuntimeRequest(input, requestedBy, update);
    if (update && !this.supportsUpdate(input.target))
      throw new RestartRequestError("Source updates are unavailable for this target");
    this.reconcilePending();
    const active = this.jobs.find((job) => this.conflictsWithRequest(job, input));
    if (active?.status === "running")
      throw new RestartRequestError(
        "This target is already restarting. Wait for its result before requesting another restart.",
      );
    if (active && (update || active.update || active.sourceBatch))
      throw new RestartRequestError("A source update cannot share a plain restart approval");
    if (active && active.supervisorPlanSha256 !== input.supervisorPlanSha256)
      throw new RestartRequestError(
        "A different restart scope or maintenance plan already owns this target",
      );
    if (
      active &&
      (active.factoryRuntimePlanSha256 !== input.factoryRuntimePlanSha256 ||
        active.factoryRuntimeRecoveryOf !== input.factoryRuntimeRecoveryOf)
    )
      throw new RestartRequestError(
        "A different restart scope or Factory adoption plan already owns this target",
      );
    // Only plain restart requests share a target approval. Source approvals stay exact.
    if (active && (active.workerLaunchRequest || input.workerLaunchRequest))
      throw new RestartRequestError("Worker launch cannot share an ordinary restart approval");
    if (active) return this.sharePlainRequest(active, input.requireOwnerApproval === true);
    const job = this.newRequest(input, requestedBy, update);
    this.commit([...this.jobs, job]);
    return { ...job };
  }

  private newRequest(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): RestartJob {
    return {
      ...input,
      ...(update ? { update } : {}),
      id: randomUUID(),
      revision: randomUUID(),
      requestedBy,
      createdAt: new Date(this.now()).toISOString(),
      // COMPAT(restartExpiry): added in v0.11.0-beta.3.vorteo.131; retain this required wire field until older clients are retired.
      expiresAt: "9999-12-31T23:59:59.999Z",
      status: "pending",
      detail: update
        ? `Owner approval required to build and install source on ${input.target === "host" ? "Host and publish the interface" : "Dev"}, and restart its daemon.`
        : "Owner approval required. Running work on the selected daemon may be interrupted.",
    };
  }

  /** Controller-only child bookkeeping under the existing global lifecycle lock.
   * The admission adapter independently rereads the current grant and receipts. */
  reserveWorkerLaunch(input: Parameters<typeof reserveWorkerLaunch>[1]): RestartJob {
    if (!this.journal.mutate)
      throw new RestartRequestError("Atomic lifecycle journal is unavailable");
    let retained: RestartJob | undefined;
    this.journal.mutate((previous) => {
      const result = reserveWorkerLaunch(previous, input);
      retained = result.retained;
      return result.jobs;
    });
    this.loadState();
    return structuredClone(retained!);
  }

  observeWorkerLaunch(
    parentId: string,
    expected: import("@getpaseo/protocol/execution-installation").WorkerLaunch,
    observed: import("@getpaseo/protocol/execution-installation").WorkerLaunch,
  ): void {
    if (!this.journal.mutate)
      throw new RestartRequestError("Atomic lifecycle journal is unavailable");
    this.journal.mutate((previous) => progressWorkerLaunch(previous, parentId, expected, observed));
    this.loadState();
  }

  /** Receipt identity and uploaded metadata never change, even after replacement. */
  contribution(id: string) {
    for (const job of this.jobs) {
      const contribution = job.sourceBatch?.contributions.find((item) => item.id === id);
      if (contribution) return structuredClone({ contribution, batch: job });
    }
    return null;
  }

  contribute(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update: SourceUpdate,
    id: string,
    replaces?: string,
  ) {
    this.requireActive();
    this.validateOwnerApprovalOrigin(input, requestedBy);
    if (input.factoryRuntimePlanSha256 || input.factoryRuntimeRecoveryOf)
      throw new RestartRequestError(
        "Factory adoption cannot be submitted as a source contribution",
      );
    if (input.supervisorPlanSha256)
      throw new RestartRequestError(
        "Supervisor maintenance cannot be submitted as a source contribution",
      );
    if (!this.supportsUpdate(input.target) || !this.executor.prepareUpdate)
      throw new RestartRequestError("Source batching unavailable");
    const existing = this.contribution(id);
    if (existing) {
      if (
        existing.batch.target !== input.target ||
        !this.matchesContributionRequest(
          existing.contribution,
          input,
          requestedBy,
          update,
          replaces,
        )
      )
        throw new RestartRequestError("Contribution ID already belongs to a different submission");
      return existing;
    }
    let job = this.jobs.find(
      (item) => item.target === input.target && item.sourceBatch && item.status === "pending",
    );
    const contributions = structuredClone(job?.sourceBatch?.contributions ?? []);
    if (contributions.length >= 100)
      throw new RestartRequestError("Batch contribution limit reached");
    if (replaces)
      this.replaceContribution({
        contributions,
        replaces,
        requestedBy,
        requester: input.requester,
        id,
      });
    contributions.push({
      id,
      update,
      reason: input.reason,
      requester: input.requester,
      requestedBy,
      ...(this.contributionRequiresOwnerApproval(input, replaces)
        ? { requireOwnerApproval: true }
        : {}),
      createdAt: new Date(this.now()).toISOString(),
      replaces,
      status: "queued",
      detail: "Awaiting integration",
    });
    job = {
      ...(job ?? {
        ...input,
        id: randomUUID(),
        requestedBy,
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: "9999-12-31T23:59:59.999Z",
      }),
      requireOwnerApproval:
        contributions.some((item) => item.status !== "superseded" && item.requireOwnerApproval) ||
        undefined,
      revision: randomUUID(),
      status: "pending",
      update: undefined,
      devRepairs: job?.devRepairs?.map((attempt) =>
        attempt.status === "preparing"
          ? {
              ...attempt,
              status: "failed" as const,
              detail: "Source contributions changed. Capture a new repair.",
            }
          : attempt,
      ),
      sourceBatch: { status: "preparing", contributions },
      detail: "Combining submitted source. Approval is unavailable until preparation completes.",
    };
    if (this.jobs.some((item) => item.id === job.id)) this.replace(job);
    else this.commit([...this.jobs, job]);
    return this.contribution(id)!;
  }

  private contributionRequiresOwnerApproval(
    input: RestartRequest,
    replaces: string | undefined,
  ): boolean {
    // Repairs inherit the durable requirement, including across replacement chains.
    // Retry matching uses the same effective value when the submitted field was omitted.
    return Boolean(
      input.requireOwnerApproval ||
      (replaces && this.contribution(replaces)?.contribution.requireOwnerApproval),
    );
  }

  private matchesContributionRequest(
    original: SourceContribution,
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update: SourceUpdate,
    replaces: string | undefined,
  ): boolean {
    return (
      JSON.stringify(original.update) === JSON.stringify(update) &&
      original.reason === input.reason &&
      original.requester === input.requester &&
      original.requestedBy === requestedBy &&
      original.replaces === replaces &&
      Boolean(original.requireOwnerApproval) ===
        this.contributionRequiresOwnerApproval(input, replaces)
    );
  }

  private replaceContribution(input: {
    contributions: SourceContribution[];
    replaces: string;
    requestedBy: RestartJob["requestedBy"];
    requester: string | undefined;
    id: string;
  }) {
    const original = input.contributions.find((item) => item.id === input.replaces);
    if (
      !original ||
      original.requestedBy !== input.requestedBy ||
      original.requester !== input.requester ||
      !["conflict", "invalid"].includes(original.status)
    )
      throw new RestartRequestError("Only your conflicted or invalid contribution can be replaced");
    original.status = "superseded";
    original.supersededBy = input.id;
  }

  private conflictsWithRequest(job: RestartJob, input: RestartRequest): boolean {
    if (job.target !== input.target) return false;
    if (job.status === "approved" || job.status === "running") return true;
    if (job.status !== "pending") return false;
    // A reviewed recovery must remain requestable alongside unrelated pending work.
    if (input.factoryRuntimeRecoveryOf) return false;
    // Maintenance must not discard another task's unapproved source contribution.
    const separateMaintenance =
      (input.supervisorPlanSha256 || input.factoryRuntimePlanSha256) &&
      (job.update || job.sourceBatch);
    return !separateMaintenance;
  }

  private validateSupervisorRequest(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): void {
    if (input.supervisorPlanSha256) {
      if (requestedBy === "container-agent" || input.target !== "container-daemon")
        throw new RestartRequestError("Supervisor maintenance requires a trusted Host request");
      if (
        update ||
        !this.executor.restartSupervisor ||
        input.supervisorPlanSha256 !== this.executor.supervisorPlan?.()
      )
        throw new RestartRequestError("Supervisor maintenance plan is unavailable or changed");
    }
  }

  private validateFactoryRuntimeRequest(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): void {
    if (!input.factoryRuntimePlanSha256) {
      if (input.factoryRuntimeRecoveryOf)
        throw new RestartRequestError("Factory recovery requires an exact adoption plan");
      return;
    }
    if (requestedBy === "container-agent" || input.target !== "container-daemon")
      throw new RestartRequestError("Factory adoption requires a trusted Host request");
    if (
      update ||
      input.supervisorPlanSha256 ||
      !this.executor.adoptFactoryRuntime ||
      input.factoryRuntimePlanSha256 !== this.executor.factoryRuntimePlan?.()
    )
      throw new RestartRequestError("Factory adoption plan is unavailable or changed");
    this.validateFactoryRecovery(input);
  }

  private supportsUpdate(target: RestartJob["target"]): boolean {
    if (!this.executor.installUpdate) return false;
    return this.executor.supportsUpdate?.(target) ?? target === "host";
  }

  /** Owner preparation captures source once; it grants no lifecycle approval. */
  requestDevRepair(id: string, revision: string): RestartJob {
    this.requireActive();
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.revision !== revision)
      throw new RestartRequestError("Restart request is missing or changed");
    if (
      job.target !== "container-daemon" ||
      job.status !== "pending" ||
      job.sourceBatch?.status !== "conflict" ||
      job.factoryRuntimePlanSha256 ||
      job.supervisorPlanSha256
    )
      throw new RestartRequestError(
        "Only a pending Dev source conflict can be prepared for repair",
      );
    if (!this.executor.captureDevRepair || !this.executor.prepareDevRepair)
      throw new RestartRequestError("Owner Dev repair preparation is unavailable");
    if (job.devRepairs?.at(-1)?.status === "preparing")
      throw new RestartRequestError("Dev repair preparation is already running");
    if ((job.devRepairs?.length ?? 0) >= 100 || job.sourceBatch.contributions.length >= 100)
      throw new RestartRequestError("Repair history limit reached");
    const capture = this.executor.captureDevRepair(structuredClone(job.sourceBatch.contributions));
    const next: RestartJob = {
      ...job,
      revision: randomUUID(),
      requireOwnerApproval: true,
      update: undefined,
      devRepairs: [
        ...(job.devRepairs ?? []),
        {
          id: randomUUID(),
          capturedRevision: job.revision,
          createdAt: new Date(this.now()).toISOString(),
          capture,
          status: "preparing",
          detail: "Preparing captured source without restarting Dev",
        },
      ],
      detail: "Preparing Dev repair from captured source. You can cancel before installation.",
    };
    this.replace(next);
    return structuredClone(next);
  }

  private async prepareOwnerDevRepair(job: RestartJob): Promise<void> {
    const attempt = job.devRepairs?.at(-1);
    if (
      !attempt ||
      attempt.status !== "preparing" ||
      !job.sourceBatch ||
      !this.executor.prepareDevRepair
    )
      return;
    try {
      const update = await this.executor.prepareDevRepair(
        structuredClone(attempt.capture),
        structuredClone(job.sourceBatch.contributions),
      );
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status !== "pending" || current.revision !== job.revision) return;
      // Retain every original contribution. Normal batch validation proves the
      // new owner source contains them before any exact installation review.
      const contribution: SourceContribution = {
        id: attempt.id,
        update,
        reason: "Repair Dev from the captured installed Host source",
        requestedBy: "owner",
        createdAt: attempt.createdAt,
        requireOwnerApproval: true,
        status: "queued",
        detail: "Awaiting integration",
      };
      this.replace({
        ...current,
        revision: randomUUID(),
        devRepairs: current.devRepairs!.map((item) =>
          item.id === attempt.id
            ? Object.assign({}, item, {
                status: "prepared" as const,
                detail: "Captured source prepared for installation review",
              })
            : item,
        ),
        sourceBatch: {
          status: "preparing",
          contributions: [...current.sourceBatch!.contributions, contribution],
        },
        detail: "Checking captured repair source before installation review",
      });
    } catch (error) {
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status !== "pending" || current.revision !== job.revision) return;
      const detail = error instanceof Error ? error.message : "Dev repair preparation failed";
      this.replace({
        ...current,
        revision: randomUUID(),
        devRepairs: current.devRepairs!.map((item) =>
          item.id === attempt.id
            ? Object.assign({}, item, { status: "failed" as const, detail })
            : item,
        ),
        detail: `Dev repair preparation failed: ${detail}. Capture a new repair after correcting the cause.`,
      });
    }
  }

  async prepareBatches(): Promise<void> {
    if (!this.active) return;
    if (this.running || this.preparing || !this.executor.prepareUpdate) return;
    if (!this.lifecycleAdmitted()) return;
    this.preparing = true;
    try {
      // Each target owns its pending batch. A Host conflict must not starve Dev.
      const candidates = this.jobs.filter((item) => item.sourceBatch && item.status === "pending");
      for (const job of candidates) await this.prepareBatch(job);
    } finally {
      this.preparing = false;
    }
  }

  private async prepareBatch(job: RestartJob): Promise<void> {
    if (!job.sourceBatch || !this.executor.prepareUpdate) return;
    if (job.devRepairs?.at(-1)?.status === "preparing") {
      await this.prepareOwnerDevRepair(job);
      return;
    }
    const blocked = this.jobs.some(
      (item) =>
        item.id !== job.id &&
        item.target === job.target &&
        ["pending", "approved", "running"].includes(item.status),
    );
    if (blocked) {
      if (job.sourceBatch.status !== "waiting")
        this.replace({
          ...job,
          update: undefined,
          revision: randomUUID(),
          sourceBatch: { ...job.sourceBatch, status: "waiting" },
          detail: "Waiting for the earlier request for this target to finish",
        });
      return;
    }
    if (job.sourceBatch.status === "ready" && this.currentSource(job)) return;
    if (job.sourceBatch.status === "conflict") return;
    const preparing: RestartJob = {
      ...job,
      update: undefined,
      revision: randomUUID(),
      sourceBatch: { ...job.sourceBatch, status: "preparing" },
    };
    this.replace(preparing);
    try {
      const result = await this.executor.prepareUpdate(
        structuredClone(preparing.sourceBatch!.contributions),
        job.target,
      );
      const current = this.jobs.find((item) => item.id === job.id);
      // An upload, cancellation or newer preparation invalidates this result.
      if (current?.status !== "pending" || current.revision !== preparing.revision) return;
      this.replace({
        ...current,
        revision: randomUUID(),
        update: result.update,
        sourceBatch: result.batch,
        detail:
          result.batch.status === "ready"
            ? "Review the combined source before installation"
            : "Contributions need correction before this batch can be approved",
      });
    } catch (error) {
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status === "pending" && current.revision === preparing.revision)
        this.replace({
          ...current,
          detail: `Source preparation will retry: ${error instanceof Error ? error.message : "unavailable"}`,
        });
      // Preserve this batch's failure and let the other target prepare independently.
    }
  }

  decide(
    id: string,
    revision: string,
    decision: RestartDecision,
    updateSha256?: string,
    supervisorPlanSha256?: string,
    factoryRuntimePlanSha256?: string,
  ): RestartJob {
    this.requireActive();
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.revision !== revision)
      throw new RestartRequestError("Restart request is missing or changed");
    this.validateSupervisorDecision(job, decision, supervisorPlanSha256);
    this.validateFactoryRuntimeDecision(job, decision, factoryRuntimePlanSha256);
    this.validateDecision(job, decision, updateSha256);
    if (decision === "request-again") {
      if (job.status !== "rejected")
        throw new RestartRequestError("Only cancelled requests can be requested again");
      return this.request(
        {
          target: job.target,
          reason: job.reason,
          requester: job.requester,
          supervisorPlanSha256: job.supervisorPlanSha256,
          factoryRuntimePlanSha256: job.factoryRuntimePlanSha256,
          factoryRuntimeRecoveryOf: job.factoryRuntimeRecoveryOf,
        },
        "owner",
      );
    }
    if (decision === "finish-current-turns") return this.approveFinish(job);
    if (decision === "cancel") {
      if (job.status !== "approved" || (!job.whenIdle && !job.continuationCaptureRequested))
        throw new RestartRequestError("Restart is not waiting or has already dispatched");
      const next = {
        ...job,
        status: "rejected" as const,
        detail: "Queued restart cancelled by owner",
      };
      this.replace(next);
      this.candidateChecks.get(job.id)?.abort();
      return { ...next };
    }
    if (job.status === "approved" && job.whenIdle && decision === "approve") {
      const ownerRevision = randomUUID();
      const next = {
        ...job,
        revision: ownerRevision,
        whenIdle: false,
        automaticApproval: undefined,
        automaticAuthority: undefined,
        automaticDispatchAfter: undefined,
        standingManualApprovals: this.manualStandingApproval(job, "approve", ownerRevision),
        detail: "Owner approved an immediate restart, which may interrupt running tasks.",
      };
      this.replace(next);
      return { ...next };
    }
    if (job.status !== "pending")
      throw new RestartRequestError("Restart request is already decided");
    if (decision === "approve-when-idle" && !this.executor.restartWhenIdle)
      throw new RestartRequestError("Idle restarts are unavailable on this coordinator");
    const next: RestartJob = {
      ...job,
      status: decision === "reject" ? "rejected" : "approved",
      ...(decision !== "reject" ? { approvedAt: new Date(this.now()).toISOString() } : {}),
      ...(decision === "approve-when-idle"
        ? {
            whenIdle: true,
            detail:
              "Approved. Waiting until no agents will be interrupted. You can cancel before dispatch.",
          }
        : {}),
    };
    this.replace(next);
    return { ...next };
  }

  private validateFactoryRuntimeDecision(
    job: RestartJob,
    decision: RestartDecision,
    factoryRuntimePlanSha256?: string,
  ): void {
    if (job.factoryRuntimePlanSha256 && !["reject", "cancel", "request-again"].includes(decision)) {
      this.validateFactoryRecovery(job);
      if (
        factoryRuntimePlanSha256 !== job.factoryRuntimePlanSha256 ||
        factoryRuntimePlanSha256 !== this.executor.factoryRuntimePlan?.()
      )
        throw new RestartRequestError("Review the exact Factory adoption plan before approval");
      if (decision === "approve-when-idle")
        throw new RestartRequestError("Use Finish turns and restart for Factory adoption");
    }
  }

  private factoryPlanCurrent(job: RestartJob): boolean {
    return (
      !job.factoryRuntimePlanSha256 ||
      job.factoryRuntimePlanSha256 === this.executor.factoryRuntimePlan?.()
    );
  }

  private factoryRecoveryRequired(target: RestartJob["target"]): boolean {
    return this.jobs.some((job) => job.target === target && job.factoryRuntimeRecoveryRequired);
  }

  private validateFactoryRecovery(input: RestartRequest, executingId?: string): RestartJob[] {
    const unresolved = this.jobs.filter(
      (job) =>
        job.id !== executingId && job.target === input.target && job.factoryRuntimeRecoveryRequired,
    );
    const chain: RestartJob[] = [];
    let reference = input.factoryRuntimeRecoveryOf;
    while (reference) {
      const failed = unresolved.find((job) => job.id === reference && job.status === "failed");
      if (!failed || chain.includes(failed))
        throw new RestartRequestError("Factory recovery receipt is missing or changed");
      chain.push(failed);
      reference = failed.factoryRuntimeRecoveryOf;
    }
    if (chain.length !== unresolved.length)
      throw new RestartRequestError(
        "Review a recovery plan for the latest unresolved Factory adoption",
      );
    return chain;
  }

  private factoryDispatchBlocked(job: RestartJob): boolean {
    if (!this.factoryRecoveryRequired(job.target)) return false;
    if (!job.factoryRuntimePlanSha256 || !job.factoryRuntimeRecoveryOf) return true;
    try {
      this.validateFactoryRecovery(job);
      return false;
    } catch {
      return true;
    }
  }

  private finishFactoryAdoption(job: RestartJob, detail: string): void {
    // The executor has verified the exact newly approved recovery plan. Clear
    // only its linked failure chain, atomically with this success receipt.
    const prior = this.validateFactoryRecovery(job, job.id);
    this.writeState(
      this.jobs.map((current) => {
        if (current.id === job.id)
          return { ...job, factoryRuntimeRecoveryRequired: false, status: "succeeded", detail };
        if (prior.some((failed) => failed.id === current.id))
          return {
            ...current,
            factoryRuntimeRecoveryRequired: false,
            factoryRuntimeRecoveredBy: job.id,
          };
        return current;
      }),
      this.helpers,
    );
  }

  private validateSupervisorDecision(
    job: RestartJob,
    decision: RestartDecision,
    supervisorPlanSha256?: string,
  ): void {
    if (job.supervisorPlanSha256 && !["reject", "cancel", "request-again"].includes(decision)) {
      if (
        supervisorPlanSha256 !== job.supervisorPlanSha256 ||
        supervisorPlanSha256 !== this.executor.supervisorPlan?.()
      )
        throw new RestartRequestError(
          "Review this exact supervisor maintenance plan before approval",
        );
      if (decision === "approve-when-idle")
        throw new RestartRequestError("Use Finish turns and restart for supervisor maintenance");
    }
  }

  private currentSource(job: RestartJob) {
    return (
      job.update?.baseCommit === this.executor.sourceBase?.(job.target) &&
      job.sourceBatch?.webCommit === this.executor.sourceWeb?.(job.target)
    );
  }

  private validateDecision(job: RestartJob, decision: RestartDecision, updateSha256?: string) {
    validateSourceDecision(job, decision, updateSha256);
    if (decision === "reject" || decision === "cancel") return;
    if (this.factoryDispatchBlocked(job))
      throw new RestartRequestError(
        "Factory startup selection requires reconciliation before another target lifecycle approval.",
      );
    if (job.sourceBatch) {
      if (
        job.sourceBatch.status !== "ready" ||
        !job.update ||
        job.update.baseCommit !== this.executor.sourceBase?.(job.target) ||
        job.sourceBatch.webCommit !== this.executor.sourceWeb?.(job.target)
      )
        throw new RestartRequestError(
          "Combined source changed or is not ready. Refresh before approving.",
        );
    }
    if (
      this.jobs.some(
        (other) =>
          other.id !== job.id &&
          other.target === job.target &&
          ["approved", "running"].includes(other.status),
      )
    )
      throw new RestartRequestError("An earlier request is still active for this target");
  }

  private manualStandingApproval(
    job: RestartJob,
    decision: "approve" | "finish-current-turns",
    revision: string,
  ) {
    if (!job.standingDecision) return job.standingManualApprovals;
    const history = job.standingManualApprovals ?? [];
    if (history.length >= 16)
      throw new RestartRequestError("Too many owner revisions; cancel and prepare a fresh request");
    return [
      ...history,
      {
        previousRevision: job.revision,
        revision,
        decision,
        approvedAt: new Date(this.now()).toISOString(),
      },
    ];
  }

  private approveFinish(
    job: RestartJob,
    policyActivatedAt?: string,
    standing?: Omit<StandingRestartDecision, "requestRevision"> | null,
  ): RestartJob {
    if (!["pending", "approved"].includes(job.status))
      throw new RestartRequestError("Restart request is already dispatched or decided");
    if (
      !this.executor.inspect ||
      !this.executor.holdCurrentTurns ||
      !this.executor.releaseCurrentTurns ||
      !this.executor.restartWhenIdle
    )
      throw new RestartRequestError("Update the coordinator to support finishing current turns");
    const revision = randomUUID();
    const next: RestartJob = {
      ...job,
      revision,
      standingDecision: standing
        ? StandingRestartDecisionSchema.parse({ ...standing, requestRevision: revision })
        : job.standingDecision,
      standingManualApprovals: !policyActivatedAt
        ? this.manualStandingApproval(job, "finish-current-turns", revision)
        : job.standingManualApprovals,
      automaticApproval: policyActivatedAt
        ? {
            policyActivatedAt,
            requestRevision: revision,
            ...(job.update ? { sourceSha256: job.update.sha256 } : {}),
          }
        : undefined,
      automaticAuthority: policyActivatedAt
        ? (standing?.authoritySha256 ?? this.approvalPolicy.authority?.())
        : undefined,
      automaticDispatchAfter: policyActivatedAt
        ? new Date(this.now() + (this.approvalPolicy.cancellationDelayMs ?? 0)).toISOString()
        : undefined,
      status: "approved",
      approvedAt: new Date(this.now()).toISOString(),
      whenIdle: true,
      finishCurrentTurns: true,
      detail: policyActivatedAt
        ? "Automatically approved by installation policy. Finishing current turns before restart; cancellation remains available."
        : "Holding new work while current turns finish. You can cancel before restart.",
    };
    this.replace(next);
    return { ...next };
  }

  private async captureRestartContinuation(job: RestartJob): Promise<RestartJob> {
    // COMPAT(restartContinuation): old executor adapters retain their existing
    // behavior; remove once every coordinator adapter implements durable capture.
    if (!this.executor.captureRestartContinuation) {
      if (job.continuationCaptureRequested)
        throw new RestartRequestError(
          "Recorded restart continuation requires a compatible executor",
        );
      return job;
    }
    if (!this.executor.releaseRestartContinuation)
      throw new RestartRequestError("Restart continuation release is unavailable");
    const approved = () => {
      this.refreshApprovalPolicy();
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status !== "approved" || current.revision !== job.revision)
        throw new RestartRequestError("Restart permission changed before continuation capture");
      return current;
    };
    let current = approved();
    // COMPAT(restartContinuation): an older or unreachable target keeps legacy behavior.
    // Never record intent the target cannot release. Recorded intent stays for release.
    if (
      this.executor.restartContinuationAvailable &&
      !(await this.executor.restartContinuationAvailable(job.target))
    )
      return approved();
    if (current.continuationCaptureRequested && current.continuationCaptureId) {
      // An earlier idle attempt may have released this cause before its receipt was saved.
      if (!(await this.releaseIdleContinuation(current)))
        throw new RestartRequestError("Waiting for the environment to release its restart hold");
      current = approved();
    }
    if (!current.continuationCaptureRequested) {
      const idleOnly = current.whenIdle && !current.finishCurrentTurns;
      current = {
        ...current,
        continuationCaptureRequested: true,
        continuationCaptureId: idleOnly ? randomUUID() : undefined,
      };
      this.replace(current);
    }
    await this.executor.captureRestartContinuation(job.target, continuationId(current));
    this.refreshApprovalPolicy();
    const acknowledged = this.jobs.find((item) => item.id === job.id);
    if (acknowledged?.status !== "approved" || acknowledged.revision !== job.revision)
      throw new RestartRequestError("Restart permission changed during continuation capture");
    return acknowledged;
  }

  /** Idle-only restarts never hold admission while they wait for idleness. */
  private async releaseIdleContinuation(job: RestartJob): Promise<boolean> {
    try {
      const released = await this.executor.releaseRestartContinuation?.(
        job.target,
        continuationId(job),
        "cancelled",
      );
      if (!released) return false;
    } catch {
      return false;
    }
    const current = this.jobs.find((item) => item.id === job.id);
    if (current?.status === "approved")
      this.replace({ ...withoutCaptureId(current), continuationCaptureRequested: undefined });
    return true;
  }

  private async inspectBeforeRestart(job: RestartJob): Promise<RestartImpact> {
    if (!this.executor.inspect) throw new Error("Idle restart inspection is unavailable");
    if (job.finishCurrentTurns && job.standingDecision) return this.inspectStandingHold(job);
    if (job.finishCurrentTurns) {
      if (!this.executor.holdCurrentTurns) throw new Error("Graceful restart unavailable");
      job = await this.captureRestartContinuation(job);
      await this.executor.holdCurrentTurns(job.target, job.id);
    }
    return this.inspectHeldTarget(job);
  }

  private async inspectHeldTarget(job: RestartJob): Promise<RestartImpact> {
    if (!this.executor.inspect)
      throw new RestartRequestError("Idle restart inspection is unavailable");
    const impact = await this.executor.inspect(job.target);
    if (this.requiresInterruption(job) && impact.heldIdleRestartSupported !== true)
      throw new RestartRequestError("Update this environment before unattended restarts.");
    return impact;
  }

  private async inspectStandingHold(job: RestartJob): Promise<RestartImpact> {
    if (!this.executor.inspect || !this.executor.holdCurrentTurns || !job.standingDecision)
      throw new RestartRequestError("Standing hold inspection is unavailable");
    let impact = await this.inspectHeldTarget(job);
    if (!impact.restartDrainObservationSupported || impact.restartDrainId === undefined) {
      if (job.standingDecision.activationStep && this.executor.initialActivationInstance)
        return this.inspectInitialLegacyHold(job);
      throw new RestartRequestError("Target must support verified restart hold observation");
    }
    if (!job.standingHold) {
      if (impact.restartDrainId !== null)
        throw new RestartRequestError("Another restart hold requires reconciliation");
      this.refreshApprovalPolicy();
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status !== "approved" || current.revision !== job.revision)
        throw new RestartRequestError("Standing permission changed before hold reservation");
      job = {
        ...current,
        standingHold: {
          generation: randomUUID(),
          grantRevision: job.standingDecision.grantRevision,
          decisionSha256: createHash("sha256")
            .update(JSON.stringify(job.standingDecision))
            .digest("hex"),
          reservedAt: new Date(this.now()).toISOString(),
        },
      };
      // The journal's locked admission is the hold dispatch boundary. Revocation
      // after this reservation permits only observation and authorized stabilization.
      this.replace(job);
      job = await this.captureRestartContinuation(job);
      await this.executor.holdCurrentTurns(job.target, job.id);
      impact = await this.inspectHeldTarget(job);
    }
    if (!impact.restartDrainObservationSupported || impact.restartDrainId !== job.id)
      throw new RestartRequestError(
        "Reserved restart hold is unconfirmed; reconcile without repeating it",
      );
    const current = this.jobs.find((item) => item.id === job.id);
    if (!current?.standingHold || current.standingHold.generation !== job.standingHold?.generation)
      throw new RestartRequestError("Restart hold reservation changed");
    if (!current.standingHold.observedAt)
      this.replace({
        ...current,
        standingHold: { ...current.standingHold, observedAt: new Date(this.now()).toISOString() },
      });
    return impact;
  }

  private async inspectInitialLegacyHold(job: RestartJob): Promise<RestartImpact> {
    const instance = await this.executor.initialActivationInstance!(job);
    if (!job.standingHold) {
      this.refreshApprovalPolicy();
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status !== "approved" || current.revision !== job.revision)
        throw new RestartRequestError("Initial permission changed before hold reservation");
      job = {
        ...current,
        standingHold: {
          generation: randomUUID(),
          grantRevision: current.standingDecision!.grantRevision,
          decisionSha256: createHash("sha256")
            .update(JSON.stringify(current.standingDecision))
            .digest("hex"),
          reservedAt: new Date(this.now()).toISOString(),
          initialDaemonInstanceSha256: instance,
        },
      };
      this.replace(job);
      job = await this.captureRestartContinuation(job);
      await this.executor.holdCurrentTurns!(job.target, job.id);
      if ((await this.executor.initialActivationInstance!(job)) !== instance)
        throw new RestartRequestError("Initial daemon lifetime changed during hold admission");
      const acknowledged = this.jobs.find((item) => item.id === job.id);
      if (acknowledged?.status !== "approved" || acknowledged.revision !== job.revision)
        throw new RestartRequestError("Initial hold requires cancellation reconciliation");
      job = {
        ...acknowledged,
        standingHold: {
          ...job.standingHold!,
          acknowledgedAt: new Date(this.now()).toISOString(),
        },
      };
      this.replace(job);
    }
    if (
      !job.standingHold?.acknowledgedAt ||
      job.standingHold.initialDaemonInstanceSha256 !== instance
    )
      throw new RestartRequestError(
        "Initial restart hold is uncertain; reconcile without repeating it",
      );
    // A drain acknowledgment only closes admission. Preparation continues
    // asynchronously and is accounted for by the actual pending-start inventory.
    return this.executor.inspect!(job.target);
  }

  private approveTrustedHostRequests(): void {
    if (
      !this.executor.inspect ||
      !this.executor.holdCurrentTurns ||
      !this.executor.releaseCurrentTurns ||
      !this.executor.restartWhenIdle
    )
      return;
    for (const job of this.jobs) {
      if (!this.automaticApprovalCandidate(job) || !this.lifecycleAdmitted(job)) continue;
      const standing = this.approvalPolicy.standingDecision?.(job);
      const enabledAfter = this.automaticActivation(job);
      if (!enabledAfter) continue;
      const threshold = Date.parse(enabledAfter);
      if (!Number.isFinite(threshold))
        throw new RestartRequestError("Invalid Host approval policy");
      if (requestPredatesPolicy(job, threshold, standing)) continue;
      const batch = job.sourceBatch;
      if (batch) {
        if (batch.status !== "ready" || !job.update) continue;
        const included = batch.contributions.filter((item) => item.status !== "superseded");
        if (
          !included.length ||
          included.some(
            (item) =>
              item.requireOwnerApproval ||
              item.requestedBy === "owner" ||
              (standing === undefined && item.requestedBy !== "host-agent") ||
              item.status !== "included",
          )
        )
          continue;
      }
      try {
        this.validateDecision(job, "approve", job.update?.sha256);
        this.validateSupervisorDecision(job, "approve", job.supervisorPlanSha256);
      } catch (error) {
        if (error instanceof RestartRequestError) continue;
        throw error;
      }
      // Use the normal durable approval and hold path, never an immediate restart.
      this.approveFinish(job, enabledAfter, standing);
    }
  }

  maintenanceBlocker(target: RestartJob["target"]): string | null {
    if (!this.active) return "Coordinator startup must be verified before maintenance can proceed.";
    if (this.helperRecoveryRequired())
      return "Native helper recovery must finish before maintenance can proceed.";
    if (this.monitorRecoveryRequired())
      return "Preview monitor recovery must finish before maintenance can proceed.";
    if (this.factoryRecoveryRequired(target))
      return "Factory recovery must verify this environment before maintenance can proceed.";
    if (this.supervisorRecoveryRequired(target))
      return "Supervisor maintenance did not verify completion. Review a tracked recovery before automatic maintenance can continue.";
    return null;
  }

  private automaticActivation(job: RestartJob): string | null | undefined {
    const standing = this.approvalPolicy.standingDecision?.(job);
    if (standing !== undefined) return standing?.policyActivatedAt ?? null;
    if (job.supervisorPlanSha256) return this.approvalPolicy.supervisorRequestsAfter?.() ?? null;
    const activation = this.approvalPolicy.daemonRequestsAfter?.(job.target);
    return activation === undefined ? this.approvalPolicy.hostRequestsAfter : activation;
  }

  private supervisorRecoveryRequired(target: RestartJob["target"]): boolean {
    // An explicitly reviewed successful successor closes uncertainty. Pending
    // requests and failed observations never clear the earlier failure.
    return this.jobs.some(
      (job) =>
        job.target === target &&
        job.supervisorPlanSha256 &&
        job.status === "failed" &&
        !job.supervisorRecoveredBy,
    );
  }

  private automaticHostOrigin(job: RestartJob): boolean {
    const standing = this.approvalPolicy.standingDecision?.(job);
    if (standing !== undefined) return standing !== null;
    return (
      job.requestedBy === "host-agent" &&
      (!job.sourceBatch ||
        job.sourceBatch.contributions
          .filter((item) => item.status !== "superseded")
          .every((item) => item.requestedBy === "host-agent"))
    );
  }

  private automaticApprovalCandidate(job: RestartJob): boolean {
    const standing = this.approvalPolicy.standingDecision?.(job);
    return (
      job.status === "pending" &&
      !job.workerLaunchRequest &&
      this.automaticHostOrigin(job) &&
      !job.requireOwnerApproval &&
      (standing != null ||
        (!this.factoryRecoveryRequired(job.target) &&
          !this.supervisorRecoveryRequired(job.target) &&
          !job.factoryRuntimePlanSha256))
    );
  }

  /** Revoke only undispatched automatic grants; explicit owner approvals remain exact. */
  refreshApprovalPolicy(): void {
    if (!this.active) return;
    for (const job of this.jobs) {
      if (job.status !== "approved" || !job.automaticApproval) continue;
      const standing = this.approvalPolicy.standingDecision?.(job);
      const authority = standing?.authoritySha256 ?? this.approvalPolicy.authority?.();
      const standingChanged = job.standingDecision
        ? !standing ||
          JSON.stringify(
            StandingRestartDecisionSchema.parse({ ...standing, requestRevision: job.revision }),
          ) !== JSON.stringify(job.standingDecision)
        : standing !== undefined;
      const enabledAfter = this.automaticActivation(job);
      const policyChanged = job.automaticApproval.policyActivatedAt !== enabledAfter;
      const credentialsChanged = authority !== undefined && job.automaticAuthority !== authority;
      const planChanged =
        job.supervisorPlanSha256 && job.supervisorPlanSha256 !== this.executor.supervisorPlan?.();
      if (
        !standingChanged &&
        !policyChanged &&
        !credentialsChanged &&
        !planChanged &&
        this.automaticHostOrigin(job)
      )
        continue;
      this.decide(job.id, job.revision, "cancel");
    }
  }

  private async drainMonitors(): Promise<void> {
    // Factory recovery fences apply to all target maintenance, including monitor writes.
    const factoryUncertain = this.jobs.some(
      (job) => job.factoryRuntimeRecoveryRequired && !job.factoryRuntimeRecoveredBy,
    );
    if (
      !factoryUncertain &&
      !this.jobs.some(
        (job) => (job.finishCurrentTurns || job.continuationCaptureRequested) && !job.holdReleased,
      )
    ) {
      for (const job of this.monitors.filter((item) => item.status === "approved")) {
        if (this.monitorRecoveryRequired()) break;
        await this.dispatchMonitor(job);
      }
    }
  }

  private lifecycleAdmitted(job?: RestartJob): boolean {
    if (this.listServices().some(unresolvedMaintenanceService)) return false;
    if (this.jobs.some((item) => item.id !== job?.id && continuationFenced(item))) return false;
    if (this.journal.admissionAvailable?.() !== false) return true;
    return job !== undefined && this.journal.activationChildAdmissionAvailable?.(job) === true;
  }

  private async drainActivationChildren(): Promise<void> {
    this.approveTrustedHostRequests();
    for (const job of this.jobs.filter((item) => item.status === "approved")) {
      if (this.lifecycleAdmitted(job)) await this.dispatch(job);
    }
  }

  private async releaseCompletedHold(job: RestartJob): Promise<void> {
    if (!job.continuationCaptureRequested && !this.executor.releaseCurrentTurns) return;
    try {
      if (job.standingHold && !job.standingHold.releaseRequestedAt) {
        job = {
          ...job,
          standingHold: {
            ...job.standingHold,
            releaseRequestedAt: new Date(this.now()).toISOString(),
          },
        };
        // Invalidate authority before a release can reach the daemon, including
        // when its response is lost. Release retries never authorize a restart.
        this.replace(job);
      }
      if (job.continuationCaptureRequested && this.executor.releaseRestartContinuation) {
        const outcome = job.status === "succeeded" ? "ready" : "cancelled";
        const released = await this.executor.releaseRestartContinuation(
          job.target,
          continuationId(job),
          outcome,
        );
        if (!released) throw new RestartRequestError("Restart continuation remains held");
      } else {
        // COMPAT(restartContinuation): an adapter without continuation release can
        // still clear the legacy hold instead of fencing lifecycle work forever.
        if (!this.executor.releaseCurrentTurns)
          throw new RestartRequestError("Restart continuation release is unavailable");
        await this.executor.releaseCurrentTurns(job.target, job.id);
      }
      const current = this.jobs.find((item) => item.id === job.id);
      if (current) this.replace({ ...withoutCaptureId(current), holdReleased: true });
    } catch {
      const current = this.jobs.find((item) => item.id === job.id);
      if (current)
        this.replace({
          ...current,
          detail: "Waiting for the environment to release its restart hold.",
        });
    }
  }

  async drain(): Promise<void> {
    if (!this.active) return;
    this.refreshApprovalPolicy();
    if (this.running || this.preparing) return;
    if (this.executor.prepareUpdate) await this.prepareBatches();
    if (this.running || this.preparing) return;
    this.reconcilePending();
    this.running = true;
    try {
      await this.releaseFinishedHolds();
      if (await this.reconcileRetainedInterruptions()) return;
      if (this.hasServiceWork()) await this.drainServices();
      if (this.listServices().some(unresolvedMaintenanceService)) return;
      if (!this.lifecycleAdmitted()) {
        await this.drainActivationChildren();
        return;
      }
      // Release completed holds above, but never start another lifecycle operation
      // while the installed helper selection remains ambiguous.
      if (this.monitorRecoveryRequired()) return;
      if (this.helperRecoveryRequired()) {
        const blocked = this.helpers.filter(
          (job) => job.stage === "recovery_required" || job.status === "running",
        );
        const rollback = this.helpers.find(
          (job) =>
            job.status === "approved" &&
            job.operation === "native-helper-rollback" &&
            blocked.some((failed) => job.plan.recoveryOf?.id === failed.id),
        );
        if (rollback) await this.dispatchHelper(rollback);
        return;
      }
      if (this.monitors.some((job) => job.status === "approved")) await this.drainMonitors();
      if (this.monitorRecoveryRequired()) return;
      this.approveTrustedHostRequests();
      if (await this.dispatchApprovedRestarts()) return;
      if (
        !this.jobs.some(
          (job) =>
            (job.finishCurrentTurns || job.continuationCaptureRequested) && !job.holdReleased,
        )
      ) {
        for (const job of this.helpers.filter((candidate) => candidate.status === "approved")) {
          if (this.helperRecoveryRequired()) break;
          await this.dispatchHelper(job);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcileRetainedInterruptions(): Promise<boolean> {
    const jobs = this.jobs.filter((job) => job.standingInterruption && job.status === "running");
    for (const job of jobs) await this.observeInterruption(job);
    return jobs.length > 0;
  }

  private async dispatchApprovedRestarts(): Promise<boolean> {
    for (const job of this.jobs.filter((candidate) => candidate.status === "approved")) {
      await this.dispatch(job);
      if (
        this.jobs.some(
          (candidate) => candidate.status === "running" && candidate.standingInterruption,
        )
      )
        return true;
    }
    return false;
  }

  private async releaseFinishedHolds(): Promise<void> {
    for (const job of this.jobs.filter(
      (candidate) =>
        (candidate.finishCurrentTurns || candidate.continuationCaptureRequested) &&
        !candidate.holdReleased &&
        ["rejected", "failed", "succeeded"].includes(candidate.status),
    ))
      await this.releaseCompletedHold(job);
  }

  private automaticDispatchReady(job: RestartJob): boolean {
    this.refreshApprovalPolicy();
    const admitted = this.jobs.find((item) => item.id === job.id);
    if (admitted?.status !== "approved" || admitted.revision !== job.revision) return false;
    if (job.automaticApproval && this.supervisorRecoveryRequired(job.target)) return false;
    if (job.automaticDispatchAfter && this.now() < Date.parse(job.automaticDispatchAfter)) {
      const detail = `Automatically approved. Cancellation is available before ${job.automaticDispatchAfter}; no restart hold has begun.`;
      if (job.detail !== detail) this.replace({ ...job, detail });
      return false;
    }
    return true;
  }

  private async prepareApprovedUpdate(job: RestartJob): Promise<RestartJob | null> {
    if (
      !job.update ||
      !job.finishCurrentTurns ||
      !this.executor.prepareInstallation ||
      job.updatePreparation === "prepared"
    )
      return job;
    this.replace({
      ...job,
      updatePreparation: "preparing",
      detail:
        "Building and validating approved source. Current work remains admissible; cancellation is available.",
    });
    try {
      await this.executor.prepareInstallation(job);
    } catch (error) {
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status === "approved")
        this.replace({
          ...current,
          status: "failed",
          detail: restartFailureDetail(current, error),
        });
      return null;
    }
    this.refreshApprovalPolicy();
    const current = this.jobs.find((item) => item.id === job.id);
    if (current?.status !== "approved" || current.revision !== job.revision) return null;
    const prepared: RestartJob = { ...current, updatePreparation: "prepared" };
    this.replace(prepared);
    return prepared;
  }

  private async readyAfterInspection(job: RestartJob): Promise<boolean> {
    if (!job.whenIdle) return true;
    let impact: RestartImpact;
    try {
      impact = await this.inspectBeforeRestart(job);
    } catch (error) {
      impact = {
        target: job.target,
        agents: [],
        pendingStarts: 0,
        checkedAt: new Date(this.now()).toISOString(),
        idleRestartSupported: false,
        error:
          error instanceof RestartRequestError
            ? error.message
            : "Cannot verify agent activity. Waiting for the target.",
      };
    }
    // Policy and credentials may change while the target is being inspected.
    this.refreshApprovalPolicy();
    const current = this.jobs.find((candidate) => candidate.id === job.id);
    if (current?.status !== "approved" || current.revision !== job.revision) return false;
    const waiting =
      impact.error ||
      !impact.idleRestartSupported ||
      impact.agents.length > 0 ||
      impact.pendingStarts > 0;
    if (waiting) {
      const detail =
        impact.error ||
        (!impact.idleRestartSupported
          ? "Waiting for a daemon update that supports safe idle restarts"
          : `Waiting for ${impact.agents.length} active agents and ${impact.pendingStarts} starting operations`);
      if (current.detail !== detail) this.replace({ ...current, detail });
      return false;
    }
    return true;
  }

  private async standingCandidateReady(job: RestartJob): Promise<boolean> {
    if (!job.standingDecision || !job.update) return true;
    const controller = new AbortController();
    this.candidateChecks.set(job.id, controller);
    try {
      if (!this.executor.verifyPreparedInstallation)
        throw new Error("Standing source updates require built candidate verification");
      await this.executor.verifyPreparedInstallation(job, { signal: controller.signal });
    } catch (error) {
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status === "approved" && current.revision === job.revision)
        this.replace({
          ...current,
          status: "failed",
          detail: restartFailureDetail(current, error),
        });
      return false;
    } finally {
      this.candidateChecks.delete(job.id);
    }
    return this.automaticDispatchReady(job);
  }

  private async dispatch(job: RestartJob): Promise<void> {
    if (job.workerLaunchRequest) {
      this.replace({
        ...job,
        detail: "Protected Linux worker launch capability is unavailable; no effect dispatched.",
      });
      return;
    }
    await this.dispatchRestart(job);
  }

  private async prepareRestartContinuation(job: RestartJob): Promise<RestartJob | null> {
    try {
      return await this.captureRestartContinuation(job);
    } catch (error) {
      const current = this.jobs.find((item) => item.id === job.id);
      if (current?.status === "approved" && current.revision === job.revision)
        this.replace({ ...current, detail: restartFailureDetail(current, error) });
      return null;
    }
  }

  private async dispatchRestart(job: RestartJob): Promise<void> {
    if (!this.lifecycleAdmitted(job) || !this.automaticDispatchReady(job)) return;
    if (!this.interruptionAvailable(job)) {
      this.replace({
        ...job,
        detail:
          "Unattended restart verification is unavailable. Installation maintenance needs an update.",
      });
      return;
    }
    if (this.factoryDispatchBlocked(job)) {
      this.replace({
        ...job,
        detail:
          "Factory startup selection requires reconciliation before another target lifecycle operation.",
      });
      return;
    }
    if (!this.factoryPlanCurrent(job)) {
      this.replace({
        ...job,
        status: "failed",
        detail: "Factory adoption plan changed; no new hold or restart dispatched.",
      });
      return;
    }
    const prepared = await this.prepareApprovedUpdate(job);
    if (!prepared) return;
    job = prepared;
    if (!this.automaticDispatchReady(job)) return;
    if (!(await this.standingCandidateReady(job))) return;
    if (job.whenIdle && !(await this.readyAfterInspection(job))) return;
    // Inspection may have durably reserved and observed an enrolled hold.
    job = this.jobs.find((item) => item.id === job.id) ?? job;
    const captured = await this.prepareRestartContinuation(job);
    if (!captured) return;
    job = captured;
    const preparedRunning = await this.prepareRunningRestart(job);
    if (!preparedRunning || !this.automaticDispatchReady(job)) return;
    job = preparedRunning;
    // Persist uncertainty before executing any plan code. Coordinator recovery
    // keeps this fence even when the process never returned a phase receipt.
    this.replace(job);
    await this.executeDispatched(job);
  }

  /** Execution must settle within the dispatch deadline; a later result is never applied. */
  private async executeDispatched(job: RestartJob): Promise<void> {
    const fields = { jobId: job.id, target: job.target, revision: job.revision };
    this.progress("Restart dispatched; waiting for verified readiness", fields);
    const execution = this.executeApproved(job);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), this.dispatchDeadlineMs);
    });
    try {
      const outcome = await Promise.race([execution.then((detail) => ({ detail })), expired]);
      if (outcome === "expired") {
        this.expireDispatch(job, execution);
        return;
      }
      await this.finishRestartDispatch(job, outcome.detail);
      const status = this.jobs.find((item) => item.id === job.id)?.status;
      this.progress("Restart dispatch settled", { ...fields, status });
    } catch (error) {
      const detail = restartFailureDetail(job, error);
      this.replace({
        ...job,
        status: job.standingInterruption ? "running" : "failed",
        detail: job.standingInterruption
          ? "Restart outcome is unverified. Checking the target without restarting it again."
          : detail,
      });
      this.progress("Restart dispatch failed", { ...fields, detail });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Only a legacy automatic Host source update qualifies. It still waits out the
   * cancellation window, prepares and holds turns like any automatic update; the
   * setting is part of the grant authority, so changing it revokes undispatched grants.
   */
  private serviceRestartGranted(job: RestartJob): boolean {
    return Boolean(
      job.target === "host" &&
      job.update &&
      job.automaticApproval &&
      job.whenIdle &&
      !job.standingDecision &&
      !job.standingInterruption &&
      this.approvalPolicy.hostUpdateServiceRestart?.() === true &&
      // The grant must have been issued under the current setting. A change during
      // preparation never upgrades an existing grant to a full service restart.
      job.automaticAuthority !== undefined &&
      job.automaticAuthority === this.approvalPolicy.authority?.(),
    );
  }

  private expireDispatch(job: RestartJob, execution: Promise<string | null>): void {
    const fields = { jobId: job.id, target: job.target, revision: job.revision };
    const minutes = Math.round(this.dispatchDeadlineMs / 60_000);
    const current = this.jobs.find((item) => item.id === job.id);
    // Standing interruptions keep their own native observation of the outcome.
    if (
      current?.status === "running" &&
      current.revision === job.revision &&
      !job.standingInterruption
    )
      this.replace({
        ...current,
        status: "failed",
        detail: `No verified readiness within ${minutes} minutes of dispatch. The restart was not replayed; inspect the target before requesting another.`,
      });
    this.progress("Restart readiness deadline expired", { ...fields, minutes });
    void execution.then(
      (detail) =>
        this.progress("Restart outcome arrived after its deadline and was not applied", {
          ...fields,
          detail,
        }),
      (error: unknown) =>
        this.progress("Restart failed after its deadline", { ...fields, error: String(error) }),
    );
  }

  private requiresInterruption(job: RestartJob): boolean {
    // Native plan executors retain their own exact claims; worker transport does
    // not authorize supervisor replacement or Factory adoption.
    return Boolean(
      job.standingDecision &&
      job.automaticApproval &&
      !job.standingDecision.activationStep &&
      !job.supervisorPlanSha256 &&
      !job.factoryRuntimePlanSha256,
    );
  }

  private interruptionAvailable(job: RestartJob): boolean {
    if (!this.requiresInterruption(job)) return true;
    return Boolean(
      this.executor.prepareInterruption &&
      this.executor.restartHeld &&
      this.executor.observeInterruption,
    );
  }

  private async prepareRunningRestart(job: RestartJob): Promise<RestartJob | null> {
    if (!this.requiresInterruption(job)) return runningRestart(job);
    try {
      const intent = await this.serviceCall(() =>
        this.executor.prepareInterruption!(structuredClone(job)),
      );
      return runningRestart({ ...job, standingInterruption: intent });
    } catch {
      const current = this.jobs.find((candidate) => candidate.id === job.id);
      if (current?.status === "approved" && current.revision === job.revision)
        this.replace({
          ...current,
          detail: "Cannot verify current restart evidence. No new restart was dispatched.",
        });
      return null;
    }
  }

  private async finishRestartDispatch(job: RestartJob, detail: string | null): Promise<void> {
    if (job.standingInterruption) {
      this.replace({ ...job, detail: "Restart was dispatched; its outcome is still unverified." });
      await this.observeInterruption(job);
    } else if (detail === null) {
      this.replace({
        ...job,
        status: "approved",
        detail: "Waiting for the daemon to confirm it is idle before restarting.",
      });
      if (!job.finishCurrentTurns && job.continuationCaptureRequested)
        await this.releaseIdleContinuation(job);
    } else if (job.factoryRuntimePlanSha256) this.finishFactoryAdoption(job, detail);
    else if (job.supervisorPlanSha256) this.finishSupervisorMaintenance(job, detail);
    else this.replace({ ...job, status: "succeeded", detail });
  }

  private finishSupervisorMaintenance(job: RestartJob, detail: string): void {
    this.writeState(
      this.jobs.map((current) => {
        if (current.id === job.id) return { ...job, status: "succeeded" as const, detail };
        if (
          current.target === job.target &&
          current.supervisorPlanSha256 &&
          current.status === "failed" &&
          !current.supervisorRecoveredBy
        )
          return { ...current, supervisorRecoveredBy: job.id };
        return current;
      }),
      this.helpers,
    );
  }

  private async executeApproved(job: RestartJob): Promise<string | null> {
    if (
      job.automaticApproval &&
      (job.automaticApproval.requestRevision !== job.revision ||
        job.automaticApproval.sourceSha256 !== job.update?.sha256)
    )
      throw new RestartRequestError("Automatic approval no longer matches the prepared request");
    if (this.executor.verifyDispatch) await this.executor.verifyDispatch(job);
    if (job.factoryRuntimePlanSha256) {
      if (
        !this.executor.adoptFactoryRuntime ||
        job.factoryRuntimePlanSha256 !== this.executor.factoryRuntimePlan?.()
      )
        throw new RestartRequestError("Factory adoption plan changed before dispatch");
      return this.executor.adoptFactoryRuntime(job);
    }
    if (job.supervisorPlanSha256) {
      if (
        !this.executor.restartSupervisor ||
        job.supervisorPlanSha256 !== this.executor.supervisorPlan?.()
      )
        throw new RestartRequestError("Supervisor maintenance plan changed before dispatch");
      return this.executor.restartSupervisor(job);
    }
    if (job.update) {
      if (!this.executor.installUpdate) throw new Error("Source update executor unavailable");
      return this.executor.installUpdate(job, { serviceRestart: this.serviceRestartGranted(job) });
    }
    if (job.standingInterruption) {
      if (!this.executor.restartHeld)
        throw new RestartRequestError("Acknowledged restart executor is unavailable");
      return this.serviceCall(() => this.executor.restartHeld!(structuredClone(job)));
    }
    if (job.whenIdle) {
      if (!this.executor.restartWhenIdle) throw new Error("Idle restart executor unavailable");
      return this.executor.restartWhenIdle(job.target);
    }
    return this.executor.restart(job.target);
  }

  async refreshImpacts(): Promise<void> {
    if (!this.active) return;
    if (this.refreshingImpacts) return;
    this.refreshingImpacts = true;
    try {
      const impacts = await this.impacts();
      for (const impact of impacts) this.impactCache.set(impact.target, impact);
    } finally {
      this.refreshingImpacts = false;
    }
  }

  async impacts(): Promise<RestartImpact[]> {
    this.requireActive();
    return Promise.all(
      (["host", "container-daemon"] as const).map(async (target) => {
        try {
          if (!this.executor.inspect) throw new Error("Agent inspection unavailable");
          return await this.executor.inspect(target);
        } catch {
          return {
            target,
            checkedAt: new Date(this.now()).toISOString(),
            agents: [],
            pendingStarts: 0,
            idleRestartSupported: false,
            error: "Cannot verify agent activity. The target may be offline.",
          };
        }
      }),
    );
  }

  private reconcilePending(): void {
    if (!this.active) return;
    const targets = new Set<RestartJob["target"]>();
    let changed = false;
    const jobs = [...this.jobs];
    for (let index = jobs.length - 1; index >= 0; index--) {
      const job = jobs[index]!;
      if (job.status === "approved" && this.factoryDispatchBlocked(job)) {
        // Revoke an undispatched approval retained by an older coordinator. Keep
        // finishCurrentTurns so the normal durable hold-release path still runs.
        changed = true;
        jobs[index] = {
          ...job,
          revision: randomUUID(),
          status: "failed",
          detail:
            "Approval revoked for Factory recovery. Prepare a new request after reconciliation.",
        };
        continue;
      }
      if (job.status !== "pending" || job.update || job.sourceBatch) continue;
      if (targets.has(job.target)) {
        changed = true;
        jobs[index] = {
          ...job,
          status: "rejected",
          detail: "Superseded by a newer request for this target",
        };
      } else {
        targets.add(job.target);
      }
    }
    if (changed) this.commit(jobs);
  }

  private replace(next: RestartJob): void {
    this.commit(this.jobs.map((job) => (job.id === next.id ? next : job)));
  }

  private commit(jobs: RestartJob[]): void {
    this.requireActive();
    this.writeState(jobs, this.helpers);
  }
  private writeState(
    jobs: RestartJob[],
    helpers: NativeHelperJob[],
    monitors: PreviewMonitorJob[] = this.monitors,
    services: MaintenanceServiceJob[] = this.listServices(),
    evidence?: MaintenanceServiceAdmissionEvidence,
  ): void {
    const remaining = new Map<string, LifecycleJob>(
      [...jobs, ...helpers, ...monitors, ...services].map((job) => [job.id, job]),
    );
    const next: LifecycleJob[] = [];
    for (const previous of this.snapshot) {
      const job = remaining.get(previous.id);
      if (job) {
        next.push(job);
        remaining.delete(previous.id);
      }
    }
    next.push(...remaining.values());
    this.journal.write(next, evidence);
    this.snapshot = next;
    this.jobs = jobs;
    this.helpers = helpers;
    this.monitors = monitors;
  }

  private replaceService(
    previous: MaintenanceServiceJob,
    next: MaintenanceServiceJob,
    evidence?: MaintenanceServiceAdmissionEvidence,
  ): void {
    if (!this.journal.mutate)
      throw new RestartRequestError("Atomic maintenance journal is unavailable");
    this.journal.mutate((jobs) => {
      const retained = jobs.find((job) => job.id === previous.id);
      if (!retained || !isDeepStrictEqual(retained, previous))
        throw new RestartRequestError("Maintenance journal changed; inspect its current receipt");
      return jobs.map((job) => (job.id === previous.id ? next : job));
    }, evidence);
  }

  private async drainServices(): Promise<void> {
    if (!this.serviceMaintenanceAvailable()) return;
    const jobs = this.listServices();
    const job = selectMaintenanceServiceWork(
      jobs,
      (candidate) =>
        candidate.status === "running" ||
        (this.serviceMaintenanceOperations().includes(candidate.operation) &&
          (candidate.status !== "pending" || serviceCheckDue(candidate, this.now()))),
    );
    if (!job) return;
    if (job.status === "running") {
      if (serviceCheckDue(job, this.now())) await this.observeService(job);
      return;
    }
    if (this.jobs.some(continuationFenced)) return;
    // A linked successor must pass the same locked chain/exclusion admission.
    // Its exact uncertain ancestors necessarily make ordinary idle admission false.
    if (!job.proposal.recoveryOf && this.journal.admissionAvailable?.() === false) return;
    try {
      const authority = this.approvalPolicy.serviceAuthority!(job);
      if (!authority) {
        if (job.status === "approved") this.cancelService(job.id, job.revision);
        return;
      }
      if (!serviceCheckDue(job, this.now())) return;
      if (job.status === "approved" && this.now() < Date.parse(job.approval!.dispatchAfter)) return;
      const proof = serviceInspectionProof(
        job,
        await this.serviceCall(() =>
          this.executor.maintenanceServices!.inspect(structuredClone(job)),
        ),
      );
      if (
        !isDeepStrictEqual(
          this.listServices().find((item) => item.id === job.id),
          job,
        )
      )
        return;
      if (job.status === "pending") {
        this.replaceService(job, approveServiceJob(job, authority, proof, this.now()), proof);
        return;
      }
      const reserved = reserveServiceJob(job, proof, this.now());
      this.replaceService(job, reserved, proof);
      await this.executeService(reserved);
    } catch {
      this.recordServiceCheckFailure(job.id);
    }
  }

  private async serviceCall<T>(call: () => Promise<T>): Promise<T> {
    // Select the Node overload even when client ambient timer types are present.
    const scheduleTimeout: (callback: () => void, delay: number) => NodeJS.Timeout = setTimeout;
    let timer: ReturnType<typeof scheduleTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = scheduleTimeout(
        () =>
          reject(
            new RestartRequestError(
              "Native maintenance response timed out; inspect the retained generation",
            ),
          ),
        30_000,
      );
      timer.unref();
    });
    try {
      return await Promise.race([call(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async observeInterruption(job: RestartJob): Promise<void> {
    if (!this.executor.observeInterruption) return;
    if (
      job.interruptionChecks &&
      (job.interruptionChecks.attempts >= 3 ||
        this.now() < Date.parse(job.interruptionChecks.nextCheckAt))
    )
      return;
    let detail: string | null = null;
    try {
      detail = await this.serviceCall(() =>
        this.executor.observeInterruption!(structuredClone(job)),
      );
    } catch {
      // Failed inspection is uncertainty; preserve the same generation.
    }
    const retained = this.journal.read().find((candidate) => candidate.id === job.id);
    if (!retained || (retained.target !== "host" && retained.target !== "container-daemon"))
      throw new RestartRequestError("Retained interruption request is unavailable");
    const current = retained;
    if (
      current?.status !== "running" ||
      current.revision !== job.revision ||
      !isDeepStrictEqual(current.standingInterruption, job.standingInterruption)
    )
      throw new RestartRequestError("Retained interruption generation changed during observation");
    if (detail === null) {
      const attempts = Math.min(3, (current.interruptionChecks?.attempts ?? 0) + 1);
      const delays = [5000, 15000, 60000];
      const checkedAt = this.now();
      this.replace({
        ...current,
        detail:
          attempts === 3
            ? "Restart outcome remains unverified after three checks. Review installation recovery."
            : "Checking whether the approved restart completed. Its outcome is still unverified.",
        interruptionChecks: {
          attempts,
          checkedAt: new Date(checkedAt).toISOString(),
          nextCheckAt: new Date(checkedAt + delays[attempts - 1]).toISOString(),
        },
      });
      return;
    }
    this.replace({ ...current, status: "succeeded", detail });
  }

  private async executeService(job: MaintenanceServiceJob): Promise<void> {
    try {
      // This call is made only on the transition that created the reservation.
      // Reopened or uncertain generations enter observeService exclusively.
      const result = await this.serviceCall(() =>
        this.executor.maintenanceServices!.execute(
          structuredClone(job),
          structuredClone(job.reservation!),
        ),
      );
      this.retainServiceObservation(job, result);
    } catch {
      this.recordServiceCheckFailure(job.id);
    }
  }

  private async observeService(job: MaintenanceServiceJob): Promise<void> {
    try {
      const result = await this.serviceCall(() =>
        this.executor.maintenanceServices!.observe(
          structuredClone(job),
          structuredClone(job.reservation!),
        ),
      );
      this.retainServiceObservation(job, result);
    } catch {
      this.recordServiceCheckFailure(job.id);
    }
  }

  private retainServiceObservation(
    job: MaintenanceServiceJob,
    result: MaintenanceServiceNativeObservation,
  ): void {
    const current = this.listServices().find((item) => item.id === job.id);
    if (
      !current ||
      current.status !== "running" ||
      !isDeepStrictEqual(current.reservation, job.reservation)
    )
      throw new RestartRequestError("Maintenance generation changed during native observation");
    const observed = observeServiceJob(current, result, this.now());
    this.journal.mutate!(
      (jobs) => retainServiceRecoveryObservation(jobs, current, observed.job),
      observed.proof,
    );
  }

  private recordServiceCheckFailure(id: string): void {
    const current = this.listServices().find((item) => item.id === id);
    if (
      current &&
      ["pending", "approved", "running"].includes(current.status) &&
      serviceCheckDue(current, this.now())
    )
      this.replaceService(current, failedServiceCheck(current, this.now()));
  }

  listServices(): MaintenanceServiceJob[] {
    // Factory may have consumed the native intent independently. Preserve that
    // fresh receipt when ordinary daemon progress writes the shared journal.
    return this.journal.read().filter(isMaintenanceService);
  }
}

function continuationId(job: RestartJob): string {
  return job.continuationCaptureId ?? job.id;
}

/** A released capture needs no cause, and v689 strict journals reject the field. */
function withoutCaptureId(job: RestartJob): RestartJob {
  const { continuationCaptureId: _released, ...retained } = job;
  return retained;
}

/** Only an undispatched or running continuation fences other lifecycle work. A
 * terminal job keeps retrying its release without blocking unrelated recovery. */
function continuationFenced(job: RestartJob): boolean {
  return Boolean(
    job.continuationCaptureRequested &&
    !job.holdReleased &&
    (job.status === "approved" || job.status === "running"),
  );
}

function runningRestart(job: RestartJob): RestartJob {
  return {
    ...job,
    ...(job.factoryRuntimePlanSha256 ? { factoryRuntimeRecoveryRequired: true } : {}),
    status: "running",
    detail: job.update
      ? `Building approved source for ${job.target === "host" ? "Host and the interface" : "Dev"}, then verifying replacement readiness`
      : "Restarting the approved target and checking its identity and readiness",
  };
}

function restartFailureDetail(job: RestartJob, error: unknown): string {
  if (job.factoryRuntimePlanSha256)
    return "Factory adoption failed. Retained startup selection requires reconciliation.";
  return error instanceof Error ? error.message : "Restart failed";
}
