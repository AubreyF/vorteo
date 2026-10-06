import { randomUUID } from "node:crypto";
import type {
  RestartImpact,
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

  decide(
    id: string,
    revision: string,
    decision: "approve" | "reject" | "approve-when-idle" | "cancel",
  ): RestartJob {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (
      job?.revision === revision &&
      job.status === "approved" &&
      job.whenIdle &&
      decision === "cancel"
    ) {
      const next: RestartJob = {
        ...job,
        status: "rejected",
        detail: "Queued restart cancelled by owner",
      };
      this.replace(next);
      return { ...next };
    }
    if (!job || job.revision !== revision || job.status !== "pending" || decision === "cancel") {
      throw new RestartRequestError("Restart request is missing, changed, or already decided");
    }
    if (decision === "approve-when-idle" && !this.executor.restartWhenIdle) {
      throw new RestartRequestError("Idle restarts are unavailable on this coordinator");
    }
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

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
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
        if (!this.executor.inspect) throw new Error("Idle restart inspection is unavailable");
        impact = await this.executor.inspect(job.target);
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
      if (this.jobs.find((candidate) => candidate.id === job.id)?.status !== "approved") return;
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
