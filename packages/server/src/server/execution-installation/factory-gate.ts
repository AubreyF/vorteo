import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FactoryGateConfiguration } from "@getpaseo/protocol/execution-installation";
import { runFactoryVerify, type EngineCommand, type FactoryFacts } from "./factory-verify.js";

/**
 * How a restart may move Factory's controller (agreed with Factory, 2026-10-23):
 * `worker` replaces only the daemon worker, so epoch and supervisor stay; `entry`
 * re-runs the container entry, so the epoch rises and the supervisor changes;
 * `either` is supervisor maintenance, which may or may not replace the supervisor.
 */
export type FactoryRestartClass = "worker" | "entry" | "either";

/** Baselines older than this are taken again; idle restarts poll every few seconds. */
const BASELINE_TTL_MS = 120_000;

interface Baseline {
  facts: FactoryFacts;
  directory: string;
  custodyList: string;
  takenAt: number;
}

export interface FactoryGateDependencies {
  run?: EngineCommand;
  now?: () => number;
}

/** Compare Factory before and after one Dev restart; returns problems and notable changes. */
export function compareFactoryFacts(
  before: FactoryFacts,
  after: FactoryFacts,
  restartClass: FactoryRestartClass,
): { problems: string[]; notes: string[] } {
  const problems = controllerProblems(before, after, restartClass);
  const owner =
    before.ownerMode === "paused"
      ? pausedOwnerProblems(before, after)
      : runningOwner(before, after);
  return { problems: [...problems, ...owner.problems], notes: owner.notes };
}

/** Worker restarts keep the epoch and supervisor; entry restarts raise and replace them. */
function controllerProblems(
  before: FactoryFacts,
  after: FactoryFacts,
  restartClass: FactoryRestartClass,
): string[] {
  const problems: string[] = [];
  const supervisorChanged = after.supervisorPid !== before.supervisorPid;
  const epochBefore = before.epoch ?? -1;
  const epochAfter = after.epoch ?? -1;
  const entryRan = restartClass === "entry" || (restartClass === "either" && supervisorChanged);
  if (entryRan) {
    if (!supervisorChanged) problems.push("Factory's supervisor did not change");
    if (!(epochAfter > epochBefore))
      problems.push(`Factory's controller epoch did not rise (${epochBefore} to ${epochAfter})`);
    return problems;
  }
  if (supervisorChanged)
    problems.push(
      `Factory's supervisor changed (${before.supervisorPid} to ${after.supervisorPid})`,
    );
  if (epochAfter !== epochBefore)
    problems.push(`Factory's controller epoch changed (${epochBefore} to ${epochAfter})`);
  return problems;
}

/** A paused Factory must look exactly the same afterwards. */
function pausedOwnerProblems(before: FactoryFacts, after: FactoryFacts) {
  const problems: string[] = [];
  if (after.ownerMode !== "paused") problems.push("Factory was resumed during the restart");
  if (after.ownerSequence !== before.ownerSequence)
    problems.push(
      `Factory's owner sequence changed while paused (${before.ownerSequence} to ${after.ownerSequence})`,
    );
  if (after.custodyDigest !== before.custodyDigest)
    problems.push("Factory's custody records changed while paused");
  return { problems, notes: [] as string[] };
}

/** A running Factory may add custody records, raise its sequence and become paused. */
function runningOwner(before: FactoryFacts, after: FactoryFacts) {
  const problems: string[] = [];
  const notes: string[] = [];
  if (after.ownerMode === "paused") notes.push("Factory was paused during the restart");
  else if (after.ownerMode !== "running")
    problems.push(`Factory's owner mode is ${after.ownerMode ?? "unknown"}`);
  const sequenceBefore = before.ownerSequence ?? -1;
  const sequenceAfter = after.ownerSequence ?? -1;
  if (sequenceAfter < sequenceBefore)
    problems.push(
      `Factory's owner sequence went backwards (${sequenceBefore} to ${sequenceAfter})`,
    );
  else if (sequenceAfter > sequenceBefore)
    notes.push(`owner sequence ${sequenceBefore} to ${sequenceAfter}`);
  const added = (after.custodyCount ?? 0) - (before.custodyCount ?? 0);
  if (added > 0) notes.push(`${added} new custody records`);
  return { problems, notes };
}

export function factoryRestartClass(job: {
  engineRestartPlanSha256?: string;
  supervisorPlanSha256?: string;
}): FactoryRestartClass {
  if (job.engineRestartPlanSha256) return "entry";
  if (job.supervisorPlanSha256) return "either";
  return "worker";
}

export class FactoryGate {
  private readonly baselines = new Map<string, Baseline>();
  private readonly run?: EngineCommand;
  private readonly now: () => number;

  constructor(
    private readonly gate: FactoryGateConfiguration,
    dependencies: FactoryGateDependencies = {},
  ) {
    this.run = dependencies.run;
    this.now = dependencies.now ?? Date.now;
  }

  private check(mode: FactoryGateConfiguration["verify"]["ownerMode"], extraArgs: string[]) {
    const { docker, socket, container, verify } = this.gate;
    return runFactoryVerify(
      { docker, socket, container, verify: { ...verify, ownerMode: mode } },
      this.run,
      extraArgs,
    );
  }

  /** Take or reuse this job's baseline. Refuses unless Factory is in a known good state. */
  async before(jobId: string): Promise<FactoryFacts> {
    const current = this.baselines.get(jobId);
    if (current && this.now() - current.takenAt < BASELINE_TTL_MS) return current.facts;
    // Expired baselines, including those of cancelled jobs, are retaken or removed.
    for (const [id, baseline] of this.baselines)
      if (this.now() - baseline.takenAt >= BASELINE_TTL_MS) await this.discard(id);
    const directory = await mkdtemp(path.join(tmpdir(), "vorteo-factory-gate-"));
    const custodyList = path.join(directory, "custody.txt");
    try {
      const facts = await this.check(this.gate.verify.ownerMode, [
        "--write-custody-list",
        custodyList,
      ]);
      if (!facts.ok)
        throw new Error(
          `Factory check "${facts.check}" failed before restarting Dev. Nothing was changed; ask Factory to review.`,
        );
      if (facts.custodyDigest === undefined || facts.ownerSequence === undefined)
        throw new Error(
          "Factory's check script predates custody digests. Nothing was changed; pin version 2.",
        );
      this.baselines.set(jobId, { facts, directory, custodyList, takenAt: this.now() });
      return facts;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** After the new worker answers. Returns a detail for the job, or throws the difference. */
  async after(jobId: string, restartClass: FactoryRestartClass): Promise<string> {
    const baseline = this.baselines.get(jobId);
    if (!baseline) throw new Error("Factory baseline is missing; the restart was not checked.");
    try {
      const superset = ["--custody-superset-of", baseline.custodyList];
      let after = await this.check(this.gate.verify.ownerMode, superset);
      // Running to paused is allowed; the script stops at the mode, so check the rest.
      if (
        !after.ok &&
        after.check === "owner-mode" &&
        baseline.facts.ownerMode === "running" &&
        after.ownerMode === "paused"
      )
        after = await this.check("paused", superset);
      if (!after.ok)
        throw new Error(
          `Dev restarted, but Factory check "${after.check}" failed. Factory review is required; nothing will be retried.`,
        );
      const { problems, notes } = compareFactoryFacts(baseline.facts, after, restartClass);
      if (problems.length)
        throw new Error(
          `Dev restarted, but ${problems.join("; ")}. Factory review is required; nothing will be retried.`,
        );
      const summary = `Factory checks passed (epoch ${after.epoch}, owner ${after.ownerMode} ${after.ownerSequence}, ${after.custodyCount} custody records)`;
      return notes.length ? `${summary}; ${notes.join(", ")}.` : `${summary}.`;
    } finally {
      await this.discard(jobId);
    }
  }

  async discard(jobId: string): Promise<void> {
    const baseline = this.baselines.get(jobId);
    this.baselines.delete(jobId);
    if (baseline) await rm(baseline.directory, { recursive: true, force: true });
  }
}
