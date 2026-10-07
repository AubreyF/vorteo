import { randomUUID } from "node:crypto";
import type {
  RestartImpact,
  RestartDecision,
  RestartJob,
  RestartRequest,
} from "@getpaseo/protocol/execution-installation";

export interface RestartJournal {
  read(): RestartJob[];
  write(jobs: RestartJob[]): void;
}

export interface RestartExecutor {
  restart(target: RestartJob["target"]): Promise<string>;
  inspect?(target: RestartJob["target"]): Promise<RestartImpact>;
  restartWhenIdle?(target: RestartJob["target"]): Promise<string | null>;
  holdCurrentTurns?(target: RestartJob["target"], requestId: string): Promise<void>;
  releaseCurrentTurns?(target: RestartJob["target"], requestId: string): Promise<void>;
}

export class RestartRequestError extends Error {}

/** The coordinator owns this queue, so daemon restarts cannot destroy the receipt. */
export class InstallationRestarts {
  private jobs: RestartJob[];
  private running = false;
  private refreshingImpacts = false;
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
    return this.jobs.map((job) => ({ ...job, impact: this.impactCache.get(job.target) }));
  }

  request(input: RestartRequest, requestedBy: RestartJob["requestedBy"]): RestartJob {
    this.reconcilePending();
    const active = this.jobs.find((job) => {
      if (job.target !== input.target) return false;
      if (job.status === "approved" || job.status === "running") return true;
      return job.status === "pending";
    });
    if (active)
      throw new RestartRequestError("A restart request for this target is already active");
    const job: RestartJob = {
      ...input,
      id: randomUUID(),
      revision: randomUUID(),
      requestedBy,
      createdAt: new Date(this.now()).toISOString(),
      // COMPAT(restartExpiry): added in v0.11.0-beta.3.vorteo.131; retain this required wire field until older clients are retired.
      expiresAt: "9999-12-31T23:59:59.999Z",
      status: "pending",
      detail: "Owner approval required. Running work on the selected daemon may be interrupted.",
    };
    this.commit([...this.jobs, job]);
    return { ...job };
  }

  decide(id: string, revision: string, decision: RestartDecision): RestartJob {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.revision !== revision)
      throw new RestartRequestError("Restart request is missing or changed");
    if (decision === "request-again") {
      if (job.status !== "rejected")
        throw new RestartRequestError("Only cancelled requests can be requested again");
      return this.request(
        { target: job.target, reason: job.reason, requester: job.requester },
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
      detail: "Restarting the approved target and checking its identity and readiness",
    });
    try {
      let detail: string | null;
      if (job.whenIdle) {
        if (!this.executor.restartWhenIdle) throw new Error("Idle restart executor unavailable");
        detail = await this.executor.restartWhenIdle(job.target);
      } else {
        detail = await this.executor.restart(job.target);
      }
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
      if (job.status !== "pending") continue;
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
