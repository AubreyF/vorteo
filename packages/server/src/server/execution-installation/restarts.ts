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
import { createHash, randomUUID } from "node:crypto";
import type {
  RestartImpact,
  RestartDecision,
  RestartJob,
  RestartRequest,
  SourceContribution,
  SourceBatch,
  SourceUpdate,
} from "@getpaseo/protocol/execution-installation";

export interface RestartApprovalPolicy {
  hostRequestsAfter?: string;
}

export interface RestartJournal {
  read(): LifecycleJob[];
  write(jobs: LifecycleJob[]): void;
}

export interface RestartExecutor {
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
  installUpdate?(job: RestartJob): Promise<string>;
  restart(target: RestartJob["target"]): Promise<string>;
  inspect?(target: RestartJob["target"]): Promise<RestartImpact>;
  restartWhenIdle?(target: RestartJob["target"]): Promise<string | null>;
  holdCurrentTurns?(target: RestartJob["target"], requestId: string): Promise<void>;
  releaseCurrentTurns?(target: RestartJob["target"], requestId: string): Promise<void>;
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
export class InstallationRestarts {
  private jobs: RestartJob[];
  private helpers: NativeHelperJob[];
  private snapshot: LifecycleJob[];
  private active = false;
  private running = false;
  private refreshingImpacts = false;
  private preparing = false;
  private readonly impactCache = new Map<RestartJob["target"], RestartImpact>();

  constructor(
    private readonly journal: RestartJournal,
    private readonly executor: RestartExecutor,
    private readonly now: () => number = Date.now,
    private readonly approvalPolicy: RestartApprovalPolicy = {},
    startup: { fenced: boolean } = { fenced: false },
  ) {
    this.snapshot = journal.read();
    this.jobs = this.snapshot.filter((job): job is RestartJob => job.target !== "native-helper");
    this.helpers = this.snapshot.filter(
      (job): job is NativeHelperJob => job.target === "native-helper",
    );
    if (!startup.fenced) this.activate();
  }

  /** Only the verified coordinator handoff releases this startup fence. */
  activate(): void {
    if (this.active) return;
    if (JSON.stringify(this.journal.read()) !== JSON.stringify(this.snapshot))
      throw new RestartRequestError("Restart journal changed while startup was fenced");
    // A coordinator crash leaves execution ambiguous. Never replay a disruptive action.
    const recovered = this.jobs.map((job): RestartJob => {
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
    this.writeState(recovered, helpers);
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

  request(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): RestartJob {
    this.requireActive();
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
    if (active) return { ...active };
    const job: RestartJob = {
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
    this.commit([...this.jobs, job]);
    return { ...job };
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
      const original = existing.contribution;
      if (
        existing.batch.target !== input.target ||
        JSON.stringify(original.update) !== JSON.stringify(update) ||
        original.reason !== input.reason ||
        original.requester !== input.requester ||
        original.requestedBy !== requestedBy ||
        original.replaces !== replaces
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
      revision: randomUUID(),
      status: "pending",
      update: undefined,
      sourceBatch: { status: "preparing", contributions },
      detail: "Combining submitted source. Approval is unavailable until preparation completes.",
    };
    if (this.jobs.some((item) => item.id === job.id)) this.replace(job);
    else this.commit([...this.jobs, job]);
    return this.contribution(id)!;
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

  async prepareBatches(): Promise<void> {
    if (!this.active) return;
    if (this.running || this.preparing || !this.executor.prepareUpdate) return;
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
      if (job.status !== "approved" || !job.whenIdle)
        throw new RestartRequestError("Restart is not waiting or has already dispatched");
      const next = {
        ...job,
        status: "rejected" as const,
        detail: "Queued restart cancelled by owner",
      };
      this.replace(next);
      return { ...next };
    }
    if (job.status === "approved" && job.whenIdle && decision === "approve") {
      const next = {
        ...job,
        revision: randomUUID(),
        whenIdle: false,
        automaticApproval: undefined,
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

  private approveFinish(job: RestartJob, policyActivatedAt?: string): RestartJob {
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
      automaticApproval: policyActivatedAt
        ? {
            policyActivatedAt,
            requestRevision: revision,
            ...(job.update ? { sourceSha256: job.update.sha256 } : {}),
          }
        : undefined,
      status: "approved",
      approvedAt: new Date(this.now()).toISOString(),
      whenIdle: true,
      finishCurrentTurns: true,
      detail: policyActivatedAt
        ? "Automatically approved by Host policy. Finishing current turns before restart; cancellation remains available."
        : "Holding new work while current turns finish. You can cancel before restart.",
    };
    this.replace(next);
    return { ...next };
  }

  private async inspectBeforeRestart(job: RestartJob): Promise<RestartImpact> {
    if (!this.executor.inspect) throw new Error("Idle restart inspection is unavailable");
    if (job.finishCurrentTurns) {
      if (!this.executor.holdCurrentTurns) throw new Error("Graceful restart unavailable");
      await this.executor.holdCurrentTurns(job.target, job.id);
    }
    return this.executor.inspect(job.target);
  }

  private approveTrustedHostRequests(): void {
    const enabledAfter = this.approvalPolicy.hostRequestsAfter;
    if (!enabledAfter) return;
    const threshold = Date.parse(enabledAfter);
    if (!Number.isFinite(threshold)) throw new RestartRequestError("Invalid Host approval policy");
    if (
      !this.executor.inspect ||
      !this.executor.holdCurrentTurns ||
      !this.executor.releaseCurrentTurns ||
      !this.executor.restartWhenIdle
    )
      return;
    for (const job of this.jobs) {
      if (!this.automaticApprovalCandidate(job)) continue;
      if (Date.parse(job.createdAt) < threshold) continue;
      const batch = job.sourceBatch;
      if (batch) {
        if (batch.status !== "ready" || !job.update) continue;
        const included = batch.contributions.filter((item) => item.status !== "superseded");
        if (
          !included.length ||
          included.some((item) => item.requestedBy !== "host-agent" || item.status !== "included")
        )
          continue;
      }
      try {
        this.validateDecision(job, "approve", job.update?.sha256);
      } catch (error) {
        if (error instanceof RestartRequestError) continue;
        throw error;
      }
      // Use the normal durable approval and hold path, never an immediate restart.
      this.approveFinish(job, enabledAfter);
    }
  }

  private automaticApprovalCandidate(job: RestartJob): boolean {
    return (
      job.status === "pending" &&
      job.requestedBy === "host-agent" &&
      !this.factoryRecoveryRequired(job.target) &&
      !requiresExactMaintenanceApproval(job)
    );
  }

  async drain(): Promise<void> {
    if (!this.active) return;
    if (this.running || this.preparing) return;
    if (this.executor.prepareUpdate) await this.prepareBatches();
    if (this.running || this.preparing) return;
    this.reconcilePending();
    this.running = true;
    try {
      for (const job of this.jobs.filter(
        (candidate) =>
          candidate.finishCurrentTurns &&
          !candidate.holdReleased &&
          ["rejected", "failed", "succeeded"].includes(candidate.status),
      )) {
        if (!this.executor.releaseCurrentTurns) continue;
        try {
          await this.executor.releaseCurrentTurns(job.target, job.id);
          this.replace({ ...job, holdReleased: true });
        } catch {
          // Keep release intent durable and retry without dispatching a restart.
          this.replace({
            ...job,
            detail: "Waiting for the environment to release its restart hold.",
          });
        }
      }
      // Release completed holds above, but never start another lifecycle operation
      // while the installed helper selection remains ambiguous.
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
      this.approveTrustedHostRequests();
      for (const job of this.jobs.filter((candidate) => candidate.status === "approved")) {
        await this.dispatch(job);
      }
      if (!this.jobs.some((job) => job.finishCurrentTurns && !job.holdReleased)) {
        for (const job of this.helpers.filter((candidate) => candidate.status === "approved")) {
          if (this.helperRecoveryRequired()) break;
          await this.dispatchHelper(job);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async dispatch(job: RestartJob): Promise<void> {
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
    if (job.whenIdle) {
      let impact: RestartImpact;
      try {
        impact = await this.inspectBeforeRestart(job);
      } catch {
        impact = {
          target: job.target,
          agents: [],
          pendingStarts: 0,
          checkedAt: new Date(this.now()).toISOString(),
          idleRestartSupported: false,
          error: "Cannot verify agent activity. Waiting for the target.",
        };
      }
      // Owner cancellation may arrive while the target is being inspected.
      const current = this.jobs.find((candidate) => candidate.id === job.id);
      if (current?.status !== "approved" || current.revision !== job.revision) return;
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
        if (job.detail !== detail) this.replace({ ...job, detail });
        return;
      }
    }
    job = runningRestart(job);
    // Persist uncertainty before executing any plan code. Coordinator recovery
    // keeps this fence even when the process never returned a phase receipt.
    this.replace(job);
    try {
      const detail = await this.executeApproved(job);
      if (detail === null) {
        this.replace({
          ...job,
          status: "approved",
          detail: "Waiting for the daemon to confirm it is idle before restarting.",
        });
      } else {
        if (job.factoryRuntimePlanSha256) this.finishFactoryAdoption(job, detail);
        else this.replace({ ...job, status: "succeeded", detail });
      }
    } catch (error) {
      const detail = restartFailureDetail(job, error);
      this.replace({ ...job, status: "failed", detail });
    }
  }

  private executeApproved(job: RestartJob): Promise<string | null> {
    if (
      job.automaticApproval &&
      (job.automaticApproval.requestRevision !== job.revision ||
        job.automaticApproval.sourceSha256 !== job.update?.sha256)
    )
      throw new RestartRequestError("Automatic approval no longer matches the prepared request");
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
      return this.executor.installUpdate(job);
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
  private writeState(jobs: RestartJob[], helpers: NativeHelperJob[]): void {
    const remaining = new Map<string, LifecycleJob>(
      [...jobs, ...helpers].map((job) => [job.id, job]),
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
    this.journal.write(next);
    this.snapshot = next;
    this.jobs = jobs;
    this.helpers = helpers;
  }
}

function requiresExactMaintenanceApproval(job: RestartJob): boolean {
  return Boolean(job.supervisorPlanSha256 || job.factoryRuntimePlanSha256);
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
