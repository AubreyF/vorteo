import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  InstallationUpgradeSchema,
  UpgradeStepNameSchema,
  type InstallationUpgrade,
  type UpgradeStep,
  type UpgradeStepName,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomicSync } from "../private-files.js";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import { RestartRequestError } from "./restarts.js";

/**
 * Owner-approved upgrade to one tested GitHub release. Steps run in order:
 * snapshot, fetch, Host build and restart, coordinator replacement, Dev image.
 * Every transition is written to the journal before its effect starts, so a
 * coordinator that restarts mid-upgrade (including the planned restart during
 * coordinator replacement) resumes the running step from its recorded state.
 */
export const UPGRADE_STEPS = UpgradeStepNameSchema.options;

/** Coordinator-private step state. Projected out of every reply. */
const UpgradePrivateSchema = z.strictObject({
  hostJobId: z.string().uuid().optional(),
  coordinatorNext: z.string().startsWith("/").optional(),
  coordinatorPrevious: z.string().startsWith("/").optional(),
  coordinatorLaunchedAt: z.string().datetime().optional(),
  devPreviousImage: z.string().min(1).optional(),
  devImage: z.string().min(1).optional(),
  devReplacing: z.boolean().optional(),
});
type UpgradePrivate = z.infer<typeof UpgradePrivateSchema>;

const UpgradeRecordSchema = InstallationUpgradeSchema.extend({
  private: UpgradePrivateSchema,
});
type UpgradeRecord = z.infer<typeof UpgradeRecordSchema>;

const UpgradeJournalSchema = z.strictObject({
  version: z.literal(1),
  upgrades: z.array(UpgradeRecordSchema),
});

const RETAINED_UPGRADES = 20;

export interface UpgradeJournal {
  read(): UpgradeRecord[];
  write(upgrades: UpgradeRecord[]): void;
}

export function createUpgradeJournal(directory: string): UpgradeJournal {
  const file = path.join(directory, "journal.json");
  return {
    read: () =>
      existsSync(file)
        ? UpgradeJournalSchema.parse(JSON.parse(readFileSync(file, "utf8"))).upgrades
        : [],
    write: (upgrades) =>
      writePrivateFileAtomicSync(
        file,
        JSON.stringify({ version: 1, upgrades: upgrades.slice(-RETAINED_UPGRADES) }, null, 2),
      ),
  };
}

export interface UpgradePorts {
  now(): Date;
  hasContainer: boolean;
  /** Null when the coordinator can replace itself; otherwise why it cannot. */
  coordinatorReplacement: string | null;
  /** Installed Host source commit. */
  currentCommit(): string | null;
  /** The commit a release tag names on GitHub. */
  resolveRelease(release: string): Promise<string>;
  /** Takes a safety snapshot and prunes old ones; returns its id. */
  snapshot(upgrade: InstallationUpgrade): Promise<string>;
  /** Fetches the tag into the source directory and checks it still names sourceCommit. */
  fetchRelease(upgrade: InstallationUpgrade): Promise<void>;
  /** Stages the release as a Host source update and approves it in the restart queue. */
  requestHostUpdate(upgrade: InstallationUpgrade): Promise<string>;
  hostUpdate(jobId: string): { status: "running" | "succeeded" | "failed"; detail: string };
  /** The Host release directory selected now. */
  hostRelease(): string;
  /** The release this coordinator process runs from. */
  runningRelease(): string;
  /** The release the coordinator service link selects. */
  coordinatorRelease(): string;
  launchCoordinatorSwap(upgrade: InstallationUpgrade, next: string, previous: string): void;
  coordinatorOutcome(upgradeId: string): HandoffOutcome | null;
  /** How long the swap helper may take before the step is judged from the link alone. */
  coordinatorDeadlineMs: number;
  devImage(): Promise<string>;
  buildDevImage(upgrade: InstallationUpgrade): Promise<string>;
  /** Recreates Dev on an image. Throws when Dev does not become healthy. */
  replaceDevImage(image: string): Promise<void>;
  /** Throws unless the coordinator reaches the recreated Dev daemon. */
  verifyDev(): Promise<void>;
}

type StepResult =
  | { status: "waiting"; detail?: string; private?: Partial<UpgradePrivate> }
  | {
      status: Exclude<UpgradeStep["status"], "pending" | "running">;
      detail: string;
      private?: Partial<UpgradePrivate>;
      snapshotId?: string;
    };

function project(record: UpgradeRecord): InstallationUpgrade {
  const { private: _private, ...upgrade } = record;
  return upgrade;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class InstallationUpgrades {
  private records: UpgradeRecord[];
  private draining = false;

  constructor(
    private readonly journal: UpgradeJournal,
    private readonly ports: UpgradePorts,
  ) {
    this.records = journal.read();
  }

  list(): InstallationUpgrade[] {
    return this.records.map(project).toReversed();
  }

  active(): InstallationUpgrade | null {
    const record = this.activeRecord();
    return record ? project(record) : null;
  }

  private activeRecord(): UpgradeRecord | undefined {
    return this.records.find((item) => ["pending", "approved", "running"].includes(item.status));
  }

  private save(record: UpgradeRecord, changes: Partial<UpgradeRecord>): UpgradeRecord {
    const next = UpgradeRecordSchema.parse({ ...record, ...changes, revision: randomUUID() });
    this.records = this.records.map((item) => (item.id === record.id ? next : item));
    this.journal.write(this.records);
    return next;
  }

  async request(release: string): Promise<InstallationUpgrade> {
    if (this.activeRecord())
      throw new RestartRequestError("Another upgrade is already pending or running");
    const sourceCommit = await this.ports.resolveRelease(release);
    const previousCommit = this.ports.currentCommit();
    if (previousCommit === sourceCommit)
      throw new RestartRequestError(`This installation already runs ${release}`);
    const now = this.ports.now().toISOString();
    const record = UpgradeRecordSchema.parse({
      id: randomUUID(),
      revision: randomUUID(),
      release,
      sourceCommit,
      previousCommit,
      createdAt: now,
      status: "pending",
      detail: "Waiting for owner approval.",
      steps: UPGRADE_STEPS.map((name) => ({ name, status: "pending", detail: "" })),
      private: {},
    });
    this.records = [...this.records, record];
    this.journal.write(this.records);
    return project(record);
  }

  decide(
    id: string,
    revision: string,
    decision: "approve" | "reject" | "cancel",
  ): InstallationUpgrade {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new RestartRequestError("Upgrade not found");
    if (record.revision !== revision)
      throw new RestartRequestError("The upgrade changed. Review it again.");
    const now = this.ports.now().toISOString();
    if (decision === "approve" && record.status === "pending")
      return project(
        this.save(record, { status: "approved", approvedAt: now, detail: "Approved. Starting." }),
      );
    if (decision === "reject" && record.status === "pending")
      return project(this.save(record, { status: "rejected", detail: "Rejected by the owner." }));
    if (decision === "cancel" && (record.status === "pending" || record.status === "approved"))
      return project(this.save(record, { status: "cancelled", detail: "Cancelled by the owner." }));
    throw new RestartRequestError(`An upgrade that is ${record.status} cannot be changed that way`);
  }

  /** Advances the active upgrade as far as it can go now. Safe to call repeatedly. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const record = this.activeRecord();
        if (!record || record.status === "pending") return;
        const advanced = await this.advance(record);
        if (!advanced) return;
      }
    } finally {
      this.draining = false;
    }
  }

  private async advance(input: UpgradeRecord): Promise<boolean> {
    let record = input;
    if (record.status === "approved")
      record = this.save(record, { status: "running", detail: "Upgrade running." });
    const index = record.steps.findIndex((step) => !this.finished(step));
    if (index === -1) {
      this.save(record, { status: "succeeded", detail: `Upgraded to ${record.release}.` });
      return false;
    }
    const step = record.steps[index];
    const now = this.ports.now().toISOString();
    if (step.status === "pending")
      record = this.saveStep(record, index, { status: "running", detail: "", startedAt: now });
    let result: StepResult;
    try {
      result = await this.run(step.name, record);
    } catch (error) {
      result = { status: "failed", detail: message(error) };
    }
    const latest = this.records.find((item) => item.id === record.id) ?? record;
    const privateState = { ...latest.private, ...result.private };
    if (result.status === "waiting") {
      this.save(latest, {
        private: privateState,
        ...(result.detail
          ? { steps: this.stepsWith(latest, index, { detail: result.detail }) }
          : {}),
      });
      return false;
    }
    const steps = this.stepsWith(latest, index, {
      status: result.status,
      detail: result.detail,
      finishedAt: this.ports.now().toISOString(),
    });
    const failed = result.status === "failed" || result.status === "rolled-back";
    this.save(latest, {
      private: privateState,
      steps: failed ? this.skipRemaining(steps, index) : steps,
      ...(result.snapshotId ? { snapshotId: result.snapshotId } : {}),
      ...(failed ? { status: "failed", detail: result.detail } : {}),
    });
    return !failed;
  }

  private finished(step: UpgradeStep): boolean {
    return step.status !== "pending" && step.status !== "running";
  }

  private stepsWith(record: UpgradeRecord, index: number, changes: Partial<UpgradeStep>) {
    return record.steps.map((step, position) =>
      position === index ? { ...step, ...changes } : step,
    );
  }

  private skipRemaining(steps: UpgradeStep[], index: number): UpgradeStep[] {
    return steps.map((step, position) =>
      position > index ? { ...step, status: "skipped" as const, detail: "Not run." } : step,
    );
  }

  private saveStep(record: UpgradeRecord, index: number, changes: Partial<UpgradeStep>) {
    return this.save(record, { steps: this.stepsWith(record, index, changes) });
  }

  private run(name: UpgradeStepName, record: UpgradeRecord): Promise<StepResult> {
    switch (name) {
      case "snapshot":
        return this.runSnapshot(record);
      case "fetch":
        return this.runFetch(record);
      case "host":
        return this.runHost(record);
      case "coordinator":
        return this.runCoordinator(record);
      case "dev":
        return this.runDev(record);
    }
  }

  private async runSnapshot(record: UpgradeRecord): Promise<StepResult> {
    const snapshotId = await this.ports.snapshot(project(record));
    return { status: "succeeded", detail: `Snapshot ${snapshotId} saved.`, snapshotId };
  }

  private async runFetch(record: UpgradeRecord): Promise<StepResult> {
    await this.ports.fetchRelease(project(record));
    return { status: "succeeded", detail: `Fetched ${record.release} (${record.sourceCommit}).` };
  }

  private async runHost(record: UpgradeRecord): Promise<StepResult> {
    const jobId = record.private.hostJobId;
    if (!jobId) {
      if (this.ports.currentCommit() === record.sourceCommit)
        return { status: "skipped", detail: "The Host already runs this release." };
      const created = await this.ports.requestHostUpdate(project(record));
      return {
        status: "waiting",
        detail: "Building the release. The Host daemon restarts when the build passes.",
        private: { hostJobId: created },
      };
    }
    const job = this.ports.hostUpdate(jobId);
    if (job.status === "running") return { status: "waiting" };
    if (job.status === "failed") return { status: "failed", detail: job.detail };
    return { status: "succeeded", detail: job.detail };
  }

  private async runCoordinator(record: UpgradeRecord): Promise<StepResult> {
    if (this.ports.coordinatorReplacement !== null)
      return { status: "skipped", detail: this.ports.coordinatorReplacement };
    const state = record.private;
    if (!state.coordinatorLaunchedAt) {
      const next = this.ports.hostRelease();
      const previous = this.ports.coordinatorRelease();
      if (previous === next && this.ports.runningRelease() === next)
        return { status: "succeeded", detail: "The coordinator already runs this release." };
      // Record the launch before it happens: the helper restarts this process.
      const launched = this.save(record, {
        private: {
          ...state,
          coordinatorNext: next,
          coordinatorPrevious: previous,
          coordinatorLaunchedAt: this.ports.now().toISOString(),
        },
      });
      this.ports.launchCoordinatorSwap(project(launched), next, previous);
      return { status: "waiting", detail: "Restarting the coordinator on the new release." };
    }
    const outcome = this.ports.coordinatorOutcome(record.id);
    if (outcome?.status === "succeeded") return { status: "succeeded", detail: outcome.detail };
    if (outcome?.status === "rolled-back") return { status: "rolled-back", detail: outcome.detail };
    if (outcome?.status === "failed") return { status: "failed", detail: outcome.detail };
    const elapsed = this.ports.now().getTime() - Date.parse(state.coordinatorLaunchedAt);
    if (elapsed < this.ports.coordinatorDeadlineMs) return { status: "waiting" };
    // The helper never reported. Judge by what this process runs.
    return this.ports.runningRelease() === state.coordinatorNext
      ? { status: "succeeded", detail: "The coordinator runs the new release." }
      : {
          status: "failed",
          detail: "The coordinator handoff did not report and the previous coordinator is running.",
        };
  }

  private async runDev(record: UpgradeRecord): Promise<StepResult> {
    if (!this.ports.hasContainer)
      return { status: "skipped", detail: "This installation has no Dev container." };
    let state = record.private;
    const persist = (changes: Partial<UpgradePrivate>) => {
      const latest = this.records.find((item) => item.id === record.id) ?? record;
      state = { ...latest.private, ...changes };
      this.save(latest, { private: state });
    };
    const previous = state.devPreviousImage ?? (await this.ports.devImage());
    persist({ devPreviousImage: previous });
    const image = state.devImage ?? (await this.ports.buildDevImage(project(record)));
    persist({ devImage: image });
    // A coordinator that restarted while Dev was being recreated checks what runs now.
    const resumed = state.devReplacing === true && (await this.ports.devImage()) === image;
    persist({ devReplacing: true });
    try {
      if (!resumed) await this.ports.replaceDevImage(image);
      await this.ports.verifyDev();
    } catch (error) {
      try {
        if ((await this.ports.devImage()) !== previous) await this.ports.replaceDevImage(previous);
      } catch (rollbackError) {
        return {
          status: "failed",
          detail: `Dev failed on the new image (${message(error)}) and the previous image did not come back (${message(rollbackError)}).`,
          private: { devReplacing: false },
        };
      }
      return {
        status: "rolled-back",
        detail: `Dev failed on the new image (${message(error)}). Dev runs the previous image again.`,
        private: { devReplacing: false },
      };
    }
    return {
      status: "succeeded",
      detail: `Dev runs ${image}.`,
      private: { devReplacing: false },
    };
  }
}
