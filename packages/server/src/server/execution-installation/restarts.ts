import { randomUUID } from "node:crypto";
import type {
  RestartImpact,
  RestartDecision,
  RestartJob,
  RestartRequest,
  SourceContribution,
  SourceBatch,
  SourceUpdate,
} from "@getpaseo/protocol/execution-installation";

export interface RestartJournal {
  read(): RestartJob[];
  write(jobs: RestartJob[]): void;
}

export interface RestartExecutor {
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
  if ((job.update || job.sourceBatch) && decision !== "reject") {
    if (decision !== "approve" || !job.update || updateSha256 !== job.update.sha256)
      throw new RestartRequestError(
        "Review and approve this exact source update. Idle updates are not supported.",
      );
  }
}

/** The coordinator owns this queue, so daemon restarts cannot destroy the receipt. */
export class InstallationRestarts {
  private jobs: RestartJob[];
  private running = false;
  private refreshingImpacts = false;
  private preparing = false;
  private readonly impactCache = new Map<RestartJob["target"], RestartImpact>();

  constructor(
    private readonly journal: RestartJournal,
    private readonly executor: RestartExecutor,
    private readonly now: () => number = Date.now,
  ) {
    this.jobs = journal.read();
    // A coordinator crash leaves execution ambiguous. Never replay a disruptive action.
    this.jobs = this.jobs.map((job) => {
      if (job.status === "approved" && job.whenIdle) return job;
      if (job.status !== "running" && job.status !== "approved") return job;
      return {
        ...job,
        status: "failed",
        detail: "Coordinator interrupted. Inspect target and request a new restart.",
      };
    });
    journal.write(this.jobs);
    this.reconcilePending();
  }

  list(): RestartJob[] {
    this.reconcilePending();
    return structuredClone(
      this.jobs.map((job) => ({ ...job, impact: this.impactCache.get(job.target) })),
    );
  }

  request(
    input: RestartRequest,
    requestedBy: RestartJob["requestedBy"],
    update?: RestartJob["update"],
  ): RestartJob {
    this.validateSupervisorRequest(input, requestedBy, update);
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
    // Maintenance must not discard another task's unapproved source contribution.
    const separateMaintenance = input.supervisorPlanSha256 && (job.update || job.sourceBatch);
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

  private supportsUpdate(target: RestartJob["target"]): boolean {
    if (!this.executor.installUpdate) return false;
    return this.executor.supportsUpdate?.(target) ?? target === "host";
  }

  async prepareBatches(): Promise<void> {
    if (this.preparing || !this.executor.prepareUpdate) return;
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
  ): RestartJob {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.revision !== revision)
      throw new RestartRequestError("Restart request is missing or changed");
    this.validateSupervisorDecision(job, decision, supervisorPlanSha256);
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
    if (decision !== "reject" && job.sourceBatch) {
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
      decision !== "reject" &&
      this.jobs.some(
        (other) =>
          other.id !== job.id &&
          other.target === job.target &&
          ["approved", "running"].includes(other.status),
      )
    )
      throw new RestartRequestError("An earlier request is still active for this target");
  }

  private approveFinish(job: RestartJob): RestartJob {
    if (!["pending", "approved"].includes(job.status))
      throw new RestartRequestError("Restart request is already dispatched or decided");
    if (
      !this.executor.holdCurrentTurns ||
      !this.executor.releaseCurrentTurns ||
      !this.executor.restartWhenIdle
    )
      throw new RestartRequestError("Update the coordinator to support finishing current turns");
    const next: RestartJob = {
      ...job,
      revision: randomUUID(),
      status: "approved",
      approvedAt: new Date(this.now()).toISOString(),
      whenIdle: true,
      finishCurrentTurns: true,
      detail: "Holding new work while current turns finish. You can cancel before restart.",
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

  async drain(): Promise<void> {
    if (this.executor.prepareUpdate) await this.prepareBatches();
    if (this.running) return;
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
      for (const job of this.jobs.filter((candidate) => candidate.status === "approved")) {
        await this.dispatch(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async dispatch(job: RestartJob): Promise<void> {
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
    this.replace({
      ...job,
      status: "running",
      detail: job.update
        ? `Building approved source for ${job.target === "host" ? "Host and the interface" : "Dev"}, then verifying replacement readiness`
        : "Restarting the approved target and checking its identity and readiness",
    });
    try {
      const detail = await this.executeApproved(job);
      if (detail === null) {
        this.replace({
          ...job,
          status: "approved",
          detail: "Waiting for the daemon to confirm it is idle before restarting.",
        });
      } else {
        this.replace({ ...job, status: "succeeded", detail });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Restart failed";
      this.replace({ ...job, status: "failed", detail });
    }
  }

  private executeApproved(job: RestartJob): Promise<string | null> {
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
    const targets = new Set<RestartJob["target"]>();
    let changed = false;
    const jobs = [...this.jobs];
    for (let index = jobs.length - 1; index >= 0; index--) {
      const job = jobs[index]!;
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
    this.journal.write(jobs);
    this.jobs = jobs;
  }
}
