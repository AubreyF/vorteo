import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseQuotaGovernorPolicy } from "@getpaseo/protocol/quota-governor";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import {
  formatSystemNotificationPrompt,
  startAgentRun,
  type AgentRunController,
} from "../agent/agent-prompt.js";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { ScheduleStore } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleExecutionBinding,
  ScheduleRun,
  ScheduleTarget,
  StoredSchedule,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "@getpaseo/protocol/schedule/types";
import {
  ScheduleGovernorBindingSchema,
  ScheduleWorkflowBindingSchema,
} from "@getpaseo/protocol/schedule/types";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const SCHEDULE_TICK_INTERVAL_MS = 1000;

// A run failed because its target no longer exists: the agent was deleted or
// archived, or a new-agent cwd was removed. These are permanent, so the schedule
// is completed instead of retried until it burns down to its expiry.
export class ScheduleTargetGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetGoneError";
  }
}

function assertConfigurationRevision(
  schedule: StoredSchedule,
  expected: string | null | undefined,
): void {
  if (expected !== undefined && expected !== (schedule.configurationRevision ?? null)) {
    throw new Error("Schedule configuration changed. Reload it before saving your edits.");
  }
}

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildScheduleFireBody(schedule: StoredSchedule, runId: string): string {
  const heading = schedule.name
    ? `Schedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).`
    : `Schedule fired (id=${schedule.id}, run=${runId}).`;
  return `${heading}\n${schedule.prompt}`;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Schedule prompt is required");
  }
  return trimmed;
}

function applyNewAgentConfig(
  target: Extract<ScheduleTarget, { type: "new-agent" }>,
  patch: UpdateScheduleNewAgentConfig,
): Extract<ScheduleTarget, { type: "new-agent" }> {
  const config = { ...target.config };
  if (patch.quotaPolicy !== undefined) {
    if (patch.quotaPolicy === null) delete config.quotaPolicy;
    else config.quotaPolicy = parseQuotaGovernorPolicy(patch.quotaPolicy);
  }
  if (patch.provider !== undefined) {
    const trimmed = patch.provider.trim();
    if (!trimmed) {
      throw new Error("provider cannot be empty");
    }
    config.provider = trimmed;
  }
  if (patch.cwd !== undefined) {
    const trimmed = patch.cwd.trim();
    if (!trimmed) {
      throw new Error("cwd cannot be empty");
    }
    config.cwd = trimmed;
  }
  if (patch.model !== undefined) {
    const trimmed = patch.model?.trim();
    if (trimmed) {
      config.model = trimmed;
    } else {
      delete config.model;
    }
  }
  if (patch.modeId !== undefined) {
    const trimmed = patch.modeId?.trim();
    if (trimmed) {
      config.modeId = trimmed;
    } else {
      delete config.modeId;
    }
  }
  if (patch.thinkingOptionId !== undefined) {
    const trimmed = patch.thinkingOptionId?.trim();
    if (trimmed) {
      config.thinkingOptionId = trimmed;
    } else {
      delete config.thinkingOptionId;
    }
  }
  if (patch.archiveOnFinish !== undefined) {
    config.archiveOnFinish = patch.archiveOnFinish;
  }
  if (patch.isolation !== undefined) {
    config.isolation = patch.isolation;
  }
  return { ...target, config };
}

function normalizeMaxRuns(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxRuns must be a positive integer");
  }
  return value;
}

function countCompletedRuns(schedule: StoredSchedule): number {
  return schedule.runs.filter((run) => run.status !== "running").length;
}

function isProtectedSchedule(schedule: StoredSchedule): boolean {
  return (
    Boolean(schedule.governorPreparation) ||
    (schedule.target.type === "new-agent" && Boolean(schedule.target.config.quotaPolicy)) ||
    schedule.runs.some(
      (run) =>
        run.status === "running" &&
        Boolean(run.governorBinding || run.workflowBinding || run.quotaState),
    )
  );
}

function preparedExecutionBinding(
  schedule: StoredSchedule,
  binding: ScheduleExecutionBinding,
): ScheduleExecutionBinding {
  const parsed =
    "workflowId" in binding
      ? ScheduleWorkflowBindingSchema.strict().parse(binding)
      : ScheduleGovernorBindingSchema.strict().parse(binding);
  if (
    schedule.target.type === "new-agent" &&
    schedule.target.config.quotaPolicy &&
    !isDeepStrictEqual(parsed.account, schedule.target.config.quotaPolicy.account)
  )
    throw new Error("Prepared quota account does not match the schedule.");
  return parsed;
}

function retainedExecutionBinding(run: ScheduleRun): ScheduleExecutionBinding | undefined {
  if (run.workflowBinding && run.governorBinding)
    throw new Error("Ambiguous protected execution binding requires reconciliation.");
  return run.workflowBinding ?? run.governorBinding;
}

function shouldArchiveScheduleRunWorkspace(input: {
  agentId: string | null;
  archiveOnFinish?: boolean;
}): boolean {
  return input.agentId === null || (input.archiveOnFinish ?? true);
}

function isScheduleExpired(schedule: StoredSchedule, now: Date): boolean {
  return Boolean(schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime());
}

function isExpiredProtectedSchedule(schedule: StoredSchedule, now: Date): boolean {
  return isProtectedSchedule(schedule) && isScheduleExpired(schedule, now);
}

function quotaPreparationRefusal(
  prepared:
    | Awaited<ReturnType<NonNullable<ScheduleServiceOptions["quotaRunner"]>["prepare"]>>
    | undefined,
  expired: boolean,
): string {
  if (expired) return "schedule_expired";
  return prepared?.kind === "deferred" ? prepared.reason : "governor_unavailable";
}

function shouldCompleteSchedule(schedule: StoredSchedule, now: Date): boolean {
  // Expiration stops inference, not reconciliation of retained custody.
  if (
    schedule.governorPreparation ||
    (isProtectedSchedule(schedule) && schedule.runs.some((run) => run.status === "running"))
  )
    return false;
  if (isScheduleExpired(schedule, now)) {
    return true;
  }
  if (schedule.maxRuns == null) {
    return false;
  }
  return countCompletedRuns(schedule) >= schedule.maxRuns;
}

function requireSchedule(schedule: StoredSchedule | null, id: string): StoredSchedule {
  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }
  return schedule;
}

function completeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "completed",
    nextRunAt: null,
    pausedAt: null,
    updatedAt: now.toISOString(),
  };
}

function mergeScheduleCadenceTimezone(
  current: StoredSchedule["cadence"],
  next: StoredSchedule["cadence"],
): StoredSchedule["cadence"] {
  if (
    current.type === "cron" &&
    next.type === "cron" &&
    next.timezone === undefined &&
    current.timezone !== undefined
  ) {
    return {
      ...next,
      timezone: current.timezone,
    };
  }
  return next;
}

function buildRunOutput(params: {
  output: string | null;
  timelineText: string;
  finalText: string;
}): string | null {
  if (params.output && params.output.trim().length > 0) {
    return params.output;
  }
  if (params.finalText.trim().length > 0) {
    return params.finalText.trim();
  }
  if (params.timelineText.trim().length > 0) {
    return params.timelineText.trim();
  }
  return null;
}

type ScheduleAgentManager = Pick<
  AgentRunController,
  | "getAgent"
  | "reloadAgentSession"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> &
  Pick<
    AgentManager,
    | "createAgent"
    | "getRegisteredProviderIds"
    | "hydrateTimelineFromProvider"
    | "resumeAgentFromPersistence"
    | "runAgent"
    | "waitForAgentEvent"
    | "waitForAgentClose"
  >;

interface ScheduleWorkspaceCreateInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

export interface ScheduleServiceOptions {
  canStartWork?: () => boolean;
  quotaRunner?: {
    /** Resolve the durable attempt before retrying. Resume retains the same attempt identity. */
    reconcilePreparation?(schedule: StoredSchedule): Promise<"clear" | "resume" | "held">;
    prepare(
      schedule: StoredSchedule,
      scheduledFor: string,
    ): Promise<
      | { kind: "deferred"; reason: string; custody?: "none" }
      | {
          kind: "ready";
          binding: ScheduleExecutionBinding;
          resumeRunId?: string;
          /** Revoke synchronously; resolve only after durable freeze and verified settlement.
           * Preserve accounting reservations. Must be idempotent and exclude run(). */
          freezeBeforeDispatch(reason: string): Promise<void>;
          run(
            schedule: StoredSchedule,
            runId: string,
          ): Promise<ScheduleExecutionResult | { state: "frozen"; reason: string }>;
        }
    >;
  };
  paseoHome: string;
  logger: Logger;
  agentManager: ScheduleAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  now?: () => Date;
  runner?: (schedule: StoredSchedule, runId: string) => Promise<ScheduleExecutionResult>;
}

type PreparedQuotaRun = Extract<
  Awaited<ReturnType<NonNullable<ScheduleServiceOptions["quotaRunner"]>["prepare"]>>,
  { kind: "ready" }
>;
type ScheduleRunner = PreparedQuotaRun["run"];

/** Keeps cleanup independent of fallible schedule writes. The driver owns actual settlement. */
class SchedulePreparationCustody {
  prepared: PreparedQuotaRun | undefined;
  dispatched = false;
  private freezing: Promise<void> | undefined;

  freeze(reason: string): void {
    if (!this.prepared || this.dispatched || this.freezing) return;
    try {
      this.freezing = Promise.resolve(this.prepared.freezeBeforeDispatch(reason));
    } catch (error) {
      this.freezing = Promise.reject(error);
    }
    void this.freezing.catch(() => undefined);
  }

  async settle(failure: { error: unknown } | undefined): Promise<void> {
    this.freeze("dispatch_not_started");
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await this.freezing;
    } catch (cleanupError) {
      cleanupFailure = { error: cleanupError };
    }
    if (cleanupFailure) {
      if (failure)
        throw new AggregateError(
          [failure.error, cleanupFailure.error],
          "Schedule admission and preparation freeze failed.",
          { cause: cleanupFailure.error },
        );
      throw cleanupFailure.error;
    }
    if (failure) throw failure.error;
  }
}

interface PreparedScheduleAttempt {
  schedule: StoredSchedule;
  now: Date;
  manual: boolean;
  runner: ScheduleRunner;
  resumeRunId?: string;
  executionBinding?: ScheduleExecutionBinding;
  custody: SchedulePreparationCustody;
}

export class ScheduleService {
  private readonly canStartWork: () => boolean;
  private readonly quotaRunner: ScheduleServiceOptions["quotaRunner"];
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly agentManager: ScheduleAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  private readonly createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
  ) => Promise<ScheduleExecutionResult>;
  private readonly runningScheduleIds = new Set<string>();
  private readonly deletingScheduleIds = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.canStartWork = options.canStartWork ?? (() => true);
    this.quotaRunner = options.quotaRunner;
    this.logger = options.logger.child({ module: "schedule-service" });
    this.store = new ScheduleStore(join(options.paseoHome, "schedules"), this.logger);
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.createDirectoryWorkspace = options.createDirectoryWorkspace;
    this.createPaseoWorktreeWorkspace = options.createPaseoWorktreeWorkspace;
    this.archiveWorkspace = options.archiveWorkspace;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? ((schedule, runId) => this.executeSchedule(schedule, runId));
  }

  async start(): Promise<void> {
    await this.recoverInterruptedRuns();
    await this.sweepOrphanedSchedules();
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process schedule tick");
      });
    }, SCHEDULE_TICK_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async create(input: CreateScheduleInput): Promise<StoredSchedule> {
    if (input.target.type === "new-agent" && input.target.config.quotaPolicy)
      parseQuotaGovernorPolicy(input.target.config.quotaPolicy);
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    return this.createScheduleRecord(input, {
      name: trimOptionalName(input.name),
      prompt,
      target: input.target,
    });
  }

  private async createScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Promise<StoredSchedule> {
    return this.store.create(this.buildScheduleRecord(input, fields));
  }

  private buildScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Omit<StoredSchedule, "id"> {
    const now = this.now();
    const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
    const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
    return {
      name: fields.name,
      prompt: fields.prompt,
      cadence: input.cadence,
      target: fields.target,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: input.expiresAt ?? null,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      runs: [],
    };
  }

  // Idempotent create for the MCP write path: repeating a create with the same
  // name and target (e.g. babysit-pr re-registering its heartbeat) refreshes the
  // existing non-completed schedule in place instead of minting a duplicate.
  async createOrReplace(input: CreateScheduleInput): Promise<StoredSchedule> {
    if (input.target.type === "new-agent" && input.target.config.quotaPolicy)
      parseQuotaGovernorPolicy(input.target.config.quotaPolicy);
    const name = trimOptionalName(input.name);
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    if (name === null) {
      return this.createScheduleRecord(input, { name, prompt, target: input.target });
    }

    const inputTarget = input.target;
    return this.store.upsertByNameAndTarget(name, inputTarget, {
      create: async () => {
        return this.buildScheduleRecord(input, { name, prompt, target: inputTarget });
      },
      update: async (current) => {
        if (
          isProtectedSchedule(current) &&
          (Boolean(current.governorPreparation) ||
            current.status === "paused" ||
            this.runningScheduleIds.has(current.id) ||
            current.runs.some((run) => run.status === "running"))
        ) {
          throw new Error(
            "Reconcile or explicitly resume the protected schedule before replacing it.",
          );
        }
        const now = this.now();
        const cadence = mergeScheduleCadenceTimezone(current.cadence, input.cadence);
        const runOnCreate = input.runOnCreate ?? cadence.type === "every";
        const nextRunAt = runOnCreate ? now : computeNextRunAt(cadence, now);
        return {
          ...current,
          name,
          prompt,
          cadence,
          target: inputTarget,
          status: "active",
          pausedAt: null,
          nextRunAt: nextRunAt.toISOString(),
          expiresAt: input.expiresAt ?? null,
          maxRuns: normalizeMaxRuns(input.maxRuns),
          updatedAt: now.toISOString(),
        };
      },
    });
  }

  async list(): Promise<StoredSchedule[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredSchedule> {
    const schedule = await this.store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    return schedule;
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const schedule = await this.inspect(id);
    return [...schedule.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async pause(id: string): Promise<StoredSchedule> {
    const paused = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "paused") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "paused" as const,
        nextRunAt: null,
        pausedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(paused, id);
  }

  async resume(id: string): Promise<StoredSchedule> {
    const resumed = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "active") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "active" as const,
        pausedAt: null,
        nextRunAt: computeNextRunAt(schedule.cadence, now).toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(resumed, id);
  }

  private hasUnfinishedProtectedExecution(schedule: StoredSchedule): boolean {
    return (
      isProtectedSchedule(schedule) &&
      (Boolean(schedule.governorPreparation) ||
        this.runningScheduleIds.has(schedule.id) ||
        schedule.runs.some((run) => run.status === "running"))
    );
  }

  async update(input: UpdateScheduleInput): Promise<StoredSchedule> {
    const next = await this.store.update(input.id, async (schedule) => {
      assertConfigurationRevision(schedule, input.expectedConfigurationRevision);
      if (
        this.hasUnfinishedProtectedExecution(schedule) &&
        ((input.prompt !== undefined && normalizePrompt(input.prompt) !== schedule.prompt) ||
          (input.cadence !== undefined && !isDeepStrictEqual(input.cadence, schedule.cadence)))
      ) {
        throw new Error("Reconcile the protected execution before changing its prompt or cadence.");
      }
      const now = this.now();
      let updated: StoredSchedule = schedule;

      if (input.prompt !== undefined) {
        updated = { ...updated, prompt: normalizePrompt(input.prompt) };
      }

      if (input.name !== undefined) {
        updated = { ...updated, name: trimOptionalName(input.name) };
      }

      if (input.cadence !== undefined) {
        const cadence = mergeScheduleCadenceTimezone(updated.cadence, input.cadence);
        validateScheduleCadence(cadence);
        const nextRunAt =
          updated.status === "active" ? computeNextRunAt(cadence, now).toISOString() : null;
        updated = { ...updated, cadence, nextRunAt };
      }

      if (input.newAgentConfig !== undefined) {
        if (updated.target.type !== "new-agent") {
          throw new Error("new-agent config updates are only valid for new-agent target schedules");
        }
        const patchedTarget = applyNewAgentConfig(updated.target, input.newAgentConfig);
        if (
          isProtectedSchedule(updated) &&
          !isDeepStrictEqual(patchedTarget, updated.target) &&
          (Boolean(updated.governorPreparation) ||
            this.runningScheduleIds.has(updated.id) ||
            updated.runs.some((run) => run.status === "running"))
        ) {
          throw new Error(
            "Reconcile the protected execution before changing its account or configuration.",
          );
        }
        updated = {
          ...updated,
          target: patchedTarget,
        };
      }

      if (input.maxRuns !== undefined) {
        updated = { ...updated, maxRuns: normalizeMaxRuns(input.maxRuns) };
      }

      if (input.expiresAt !== undefined) {
        updated = { ...updated, expiresAt: input.expiresAt };
      }

      return { ...updated, updatedAt: now.toISOString() };
    });
    return requireSchedule(next, input.id);
  }

  async delete(id: string): Promise<void> {
    if (this.deletingScheduleIds.has(id)) throw new Error("Schedule deletion is already pending.");
    this.deletingScheduleIds.add(id);
    try {
      await this.store.delete(id, (schedule) => {
        if (this.hasUnfinishedProtectedExecution(schedule))
          throw new Error("Reconcile the protected execution before deleting its schedule.");
      });
    } finally {
      this.deletingScheduleIds.delete(id);
    }
  }

  async completeForAgent(agentId: string): Promise<number> {
    const now = this.now();
    const schedules = await this.store.list();
    const matches = schedules.filter(
      (schedule) =>
        schedule.target.type === "agent" &&
        schedule.target.agentId === agentId &&
        schedule.status !== "completed",
    );
    const results = await Promise.allSettled(
      matches.map((schedule) => this.completeScheduleForAgent(schedule.id, agentId, now)),
    );
    let completed = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        completed += 1;
      } else if (result.status === "rejected") {
        this.logger.warn(
          {
            err: result.reason,
            scheduleId: matches[index].id,
            agentId,
          },
          "Failed to complete schedule for archived agent; continuing",
        );
      }
    }
    return completed;
  }

  private async completeScheduleForAgent(
    scheduleId: string,
    agentId: string,
    now: Date,
  ): Promise<boolean> {
    let completed = false;
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.target.type !== "agent" ||
        schedule.target.agentId !== agentId ||
        schedule.status === "completed"
      ) {
        return schedule;
      }
      completed = true;
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
    return completed;
  }

  async runOnce(id: string): Promise<StoredSchedule> {
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new Error(`Schedule ${id} is already completed`);
    }
    if (this.runningScheduleIds.has(id)) {
      throw new Error(`Schedule ${id} is already running`);
    }
    await this.runSchedule(schedule, this.now(), { manual: true });
    return this.inspect(id);
  }

  async tick(): Promise<void> {
    if (!this.canStartWork()) return;
    const now = this.now();
    const schedules = await this.store.list();
    for (const schedule of schedules) {
      if (!this.canStartWork()) return;
      if (schedule.status !== "active" || !schedule.nextRunAt) {
        continue;
      }
      if (this.runningScheduleIds.has(schedule.id)) {
        continue;
      }
      if (shouldCompleteSchedule(schedule, now)) {
        await this.completeScheduleIfDue(schedule.id, now);
        continue;
      }
      if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      await this.runSchedule(schedule, now);
    }
  }

  private async completeScheduleIfDue(scheduleId: string, now: Date): Promise<void> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        !shouldCompleteSchedule(schedule, now)
      ) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    await Promise.all(
      schedules.map((schedule) => this.recoverInterruptedSchedule(schedule.id, now)),
    );
  }

  private async recoverInterruptedSchedule(scheduleId: string, now: Date): Promise<void> {
    const interruptedWorkspaces: Array<{
      workspaceId: string;
      agentId: string | null;
      runId: string;
    }> = [];
    await this.store.update(scheduleId, (current) => {
      // The governor reconciles its captured execution and preserves unfinished
      // work. The legacy restart path must not fail or archive that execution.
      if (isProtectedSchedule(current)) return current;
      let updated = { ...current };
      let dirty = false;

      const runningIndex = updated.runs.findIndex((run) => run.status === "running");
      if (runningIndex !== -1) {
        const runs = [...updated.runs];
        const runningRun = runs[runningIndex];
        if (
          updated.target.type === "new-agent" &&
          runningRun.workspaceId &&
          shouldArchiveScheduleRunWorkspace({
            agentId: runningRun.agentId,
            archiveOnFinish: updated.target.config.archiveOnFinish,
          })
        ) {
          interruptedWorkspaces.push({
            workspaceId: runningRun.workspaceId,
            agentId: runningRun.agentId,
            runId: runningRun.id,
          });
        }
        runs[runningIndex] = {
          ...runningRun,
          status: "failed",
          endedAt: now.toISOString(),
          error: "Daemon restarted before the scheduled run completed",
        };
        updated = { ...updated, runs };
        dirty = true;
      }

      if (
        updated.status === "active" &&
        updated.nextRunAt &&
        new Date(updated.nextRunAt).getTime() <= now.getTime()
      ) {
        let nextRunAt = computeNextRunAt(updated.cadence, new Date(updated.nextRunAt));
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = { ...updated, nextRunAt: nextRunAt.toISOString() };
        dirty = true;
      }

      if (dirty) {
        return { ...updated, updatedAt: now.toISOString() };
      }
      return current;
    });
    const interruptedWorkspace = interruptedWorkspaces[0];
    if (!interruptedWorkspace) {
      return;
    }
    try {
      await this.archiveWorkspace(interruptedWorkspace.workspaceId);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          agentId: interruptedWorkspace.agentId,
          workspaceId: interruptedWorkspace.workspaceId,
          scheduleId,
          runId: interruptedWorkspace.runId,
        },
        "Failed to archive interrupted scheduled workspace after daemon restart",
      );
    }
  }

  // Orphaned agent-target schedules (agent deleted while the daemon was down, or
  // archived before completeForAgent existed) can never fire successfully. Complete
  // them on startup so they stop ticking and surface as ended in the UI.
  private async sweepOrphanedSchedules(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    await Promise.all(schedules.map((schedule) => this.sweepOrphanedSchedule(schedule.id, now)));
  }

  private async sweepOrphanedSchedule(scheduleId: string, now: Date): Promise<void> {
    await this.store.update(scheduleId, async (schedule) => {
      if (schedule.target.type !== "agent" || schedule.status === "completed") {
        return schedule;
      }
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (record && !record.archivedAt) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
  }

  private async beginScheduleRun(schedule: StoredSchedule): Promise<void> {
    if (this.deletingScheduleIds.has(schedule.id)) throw new Error("Schedule deletion is pending.");
    if (this.runningScheduleIds.has(schedule.id)) throw new Error("Schedule is already running.");
    this.runningScheduleIds.add(schedule.id);
    try {
      const current = await this.store.get(schedule.id);
      if (!current || !isDeepStrictEqual(current, schedule))
        throw new Error("Schedule changed before admission.");
    } catch (error) {
      this.runningScheduleIds.delete(schedule.id);
      throw error;
    }
  }

  private async runSchedule(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
  ): Promise<void> {
    const manual = options?.manual === true;
    if (!this.canStartWork()) {
      if (manual) throw new Error("New scheduled work is held for restart.");
      return;
    }
    await this.beginScheduleRun(schedule);
    const custody = new SchedulePreparationCustody();
    let failure: { error: unknown } | undefined;
    try {
      await this.runScheduleAttempt(schedule, now, manual, custody);
    } catch (error) {
      failure = { error };
    }
    try {
      await custody.settle(failure);
    } finally {
      this.runningScheduleIds.delete(schedule.id);
    }
  }

  private async runScheduleAttempt(
    schedule: StoredSchedule,
    now: Date,
    manual: boolean,
    custody: SchedulePreparationCustody,
  ): Promise<void> {
    let runner: ScheduleRunner = this.runner;
    let resumeRunId: string | undefined;
    let executionBinding: ScheduleExecutionBinding | undefined;
    if (isProtectedSchedule(schedule)) {
      const marked = this.quotaRunner
        ? await this.prepareScheduleAttempt(
            schedule,
            manual ? now.toISOString() : (schedule.nextRunAt ?? now.toISOString()),
          )
        : schedule;
      if (!marked) return;
      const retainedPreparation = Boolean(
        schedule.governorPreparation &&
        schedule.governorPreparation.id === marked.governorPreparation?.id,
      );
      schedule = marked;
      const prepared = await this.quotaRunner?.prepare(
        schedule,
        schedule.governorPreparation?.scheduledFor ??
          (manual ? now.toISOString() : (schedule.nextRunAt ?? now.toISOString())),
      );
      if (prepared?.kind === "ready") custody.prepared = prepared;
      const expired = isScheduleExpired(schedule, this.now());
      if (!prepared || prepared.kind === "deferred" || expired) {
        custody.freeze(quotaPreparationRefusal(prepared, expired));
        await this.store.update(schedule.id, (current) => ({
          ...current,
          // Only the trusted driver can assert that this attempt acquired no custody.
          ...(prepared?.kind === "deferred" && prepared.custody === "none" && !retainedPreparation
            ? { governorPreparation: undefined }
            : {}),
          quotaState: {
            state: "held",
            reason: quotaPreparationRefusal(prepared, expired),
            checkedAt: this.now().toISOString(),
          },
        }));
        return;
      }
      executionBinding = preparedExecutionBinding(schedule, prepared.binding);
      runner = prepared.run;
      resumeRunId = prepared.resumeRunId;
    }

    await this.runPreparedSchedule({
      schedule,
      now,
      manual,
      runner,
      resumeRunId,
      executionBinding,
      custody,
    });
  }

  private async runPreparedSchedule({
    schedule,
    now,
    manual,
    runner,
    resumeRunId,
    executionBinding,
    custody,
  }: PreparedScheduleAttempt): Promise<void> {
    if (!this.canStartWork()) {
      custody.freeze("restart_pending");
      return;
    }
    const runId = resumeRunId ?? randomUUID();
    const runningRun: ScheduleRun = {
      id: runId,
      scheduledFor:
        schedule.governorPreparation?.scheduledFor ??
        (manual ? now.toISOString() : (schedule.nextRunAt ?? now.toISOString())),
      startedAt: now.toISOString(),
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
      ...(schedule.governorPreparation
        ? { governorPreparationId: schedule.governorPreparation.id }
        : {}),
    };
    if (executionBinding) {
      if ("workflowId" in executionBinding) runningRun.workflowBinding = executionBinding;
      else runningRun.governorBinding = executionBinding;
    }
    let appended = false;
    try {
      const scheduleWithRun = await this.openScheduleRun(schedule, runningRun, resumeRunId);
      appended = true;
      let result: ScheduleExecutionResult | { state: "frozen"; reason: string };
      if (isExpiredProtectedSchedule(scheduleWithRun, this.now())) {
        custody.freeze("schedule_expired");
        result = { state: "frozen", reason: "schedule_expired" };
      } else {
        custody.dispatched = true;
        result = await runner(scheduleWithRun, runId);
      }
      if ("state" in result) {
        await this.store.update(schedule.id, (current) => ({
          ...current,
          quotaState: {
            state: "held",
            reason: result.reason,
            checkedAt: this.now().toISOString(),
          },
          runs: current.runs.map((run) =>
            run.id === runId
              ? { ...run, quotaState: { state: "frozen", reason: result.reason } }
              : run,
          ),
        }));
        return;
      }
      await this.finishRun({
        scheduleId: schedule.id,
        runId,
        status: "succeeded",
        agentId: result.agentId,
        output: result.output,
        error: null,
        targetGone: false,
        manual,
      });
    } catch (error) {
      if (!appended) throw error;
      if (isProtectedSchedule(schedule)) {
        await this.store.update(schedule.id, (current) => ({
          ...current,
          quotaState: {
            state: "held",
            reason: "execution_uncertain",
            checkedAt: this.now().toISOString(),
          },
          runs: current.runs.map((run) =>
            run.id === runId
              ? {
                  ...run,
                  quotaState: { state: "reconciliation_required", reason: "execution_uncertain" },
                }
              : run,
          ),
        }));
        return;
      }
      await this.finishRun({
        scheduleId: schedule.id,
        runId,
        status: "failed",
        agentId: null,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        targetGone: error instanceof ScheduleTargetGoneError,
        manual,
      });
    }
  }

  private async prepareScheduleAttempt(
    schedule: StoredSchedule,
    scheduledFor: string,
  ): Promise<StoredSchedule | undefined> {
    if (schedule.governorPreparation) {
      const outcome = (await this.quotaRunner?.reconcilePreparation?.(schedule)) ?? "held";
      if (outcome === "held") {
        await this.store.update(schedule.id, (current) => ({
          ...current,
          quotaState: {
            state: "held",
            reason: "preparation_reconciliation_required",
            checkedAt: this.now().toISOString(),
          },
        }));
        return undefined;
      }
      if (outcome === "resume") return schedule;
    }
    const updated = await this.store.update(schedule.id, (current) => {
      if (!isDeepStrictEqual(current, schedule))
        throw new Error("Schedule changed during preparation reconciliation.");
      return { ...current, governorPreparation: { id: randomUUID(), scheduledFor } };
    });
    return requireSchedule(updated, schedule.id);
  }

  private async openScheduleRun(
    schedule: StoredSchedule,
    runningRun: ScheduleRun,
    resumeRunId?: string,
  ): Promise<StoredSchedule> {
    if (!resumeRunId) {
      if (schedule.runs.some((run) => run.status === "running"))
        throw new Error("Reconcile unfinished work before admitting another run.");
      return this.appendRunningRun(schedule.id, runningRun, schedule);
    }
    const updated = await this.store.update(schedule.id, (current) => {
      if (
        !isDeepStrictEqual(current.target, schedule.target) ||
        current.status !== schedule.status ||
        current.prompt !== schedule.prompt
      )
        throw new Error("Schedule changed during resume admission.");
      const retained = current.runs.find(
        (run) => run.id === resumeRunId && run.status === "running",
      );
      if (!retained) throw new Error("Protected run to resume is missing.");
      if (
        !retainedExecutionBinding(retained) ||
        !isDeepStrictEqual(retainedExecutionBinding(retained), retainedExecutionBinding(runningRun))
      )
        throw new Error("Protected execution binding requires reconciliation before resume.");
      if (!isDeepStrictEqual(current.governorPreparation, schedule.governorPreparation))
        throw new Error("Schedule preparation changed during resume.");
      return {
        ...current,
        governorPreparation: undefined,
        runs: current.runs.map((run) =>
          run.id === resumeRunId
            ? { ...run, governorPreparationId: runningRun.governorPreparationId }
            : run,
        ),
      };
    });
    return requireSchedule(updated, schedule.id);
  }

  private async appendRunningRun(
    scheduleId: string,
    runningRun: ScheduleRun,
    preparedSchedule: StoredSchedule,
  ): Promise<StoredSchedule> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        !isDeepStrictEqual(schedule.governorPreparation, preparedSchedule.governorPreparation) ||
        !isDeepStrictEqual(schedule.target, preparedSchedule.target) ||
        schedule.status !== preparedSchedule.status ||
        schedule.prompt !== preparedSchedule.prompt ||
        !isDeepStrictEqual(schedule.cadence, preparedSchedule.cadence) ||
        !isDeepStrictEqual(schedule.runs, preparedSchedule.runs) ||
        schedule.nextRunAt !== preparedSchedule.nextRunAt ||
        schedule.expiresAt !== preparedSchedule.expiresAt ||
        schedule.maxRuns !== preparedSchedule.maxRuns ||
        schedule.runs.some((run) => run.status === "running")
      )
        throw new Error("Schedule changed during admission.");
      return {
        ...schedule,
        quotaState: undefined,
        governorPreparation: undefined,
        updatedAt: runningRun.startedAt,
        runs: [...schedule.runs, runningRun],
      };
    });
    return requireSchedule(updated, scheduleId);
  }

  private async finishRun(params: {
    scheduleId: string;
    runId: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    output: string | null;
    error: string | null;
    targetGone: boolean;
    manual: boolean;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => {
      const now = this.now();
      const completedRuns = schedule.runs.map((run) =>
        run.id === params.runId
          ? {
              ...run,
              status: params.status,
              quotaState: undefined,
              endedAt: now.toISOString(),
              agentId: params.agentId ?? run.agentId,
              output: params.output,
              error: params.error,
            }
          : run,
      );
      let updated: StoredSchedule = {
        ...schedule,
        runs: completedRuns,
        lastRunAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaState: undefined,
      };

      if (params.targetGone) {
        // The target is permanently gone; retrying only burns the schedule down to
        // its expiry, so complete it now regardless of manual/scheduled origin.
        updated = completeSchedule(updated, now);
      } else if (updated.status === "completed") {
        // Completed concurrently (e.g. the target agent was archived mid-run);
        // record the run outcome but leave the schedule terminal — don't advance.
      } else if (params.manual) {
        // Manual one-shot runs do not advance the cadence or recompute completion.
      } else if (shouldCompleteSchedule(updated, now)) {
        updated = completeSchedule(updated, now);
      } else if (updated.status === "paused") {
        updated = {
          ...updated,
          nextRunAt: null,
        };
      } else {
        const after = new Date(schedule.nextRunAt ?? now.toISOString());
        let nextRunAt = computeNextRunAt(updated.cadence, after);
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = {
          ...updated,
          nextRunAt: nextRunAt.toISOString(),
        };
      }

      return updated;
    });
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async recordRunWorkspace(params: {
    scheduleId: string;
    runId: string;
    workspaceId: string;
    agentId: string | null;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: this.now().toISOString(),
      runs: schedule.runs.map((run) =>
        run.id === params.runId && run.status === "running"
          ? {
              ...run,
              workspaceId: params.workspaceId,
              agentId: params.agentId,
            }
          : run,
      ),
    }));
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async executeSchedule(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionResult> {
    if (schedule.target.type === "agent") {
      const wrappedPrompt = formatSystemNotificationPrompt(buildScheduleFireBody(schedule, runId));
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (!record) {
        throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} no longer exists`);
      }
      if (record.archivedAt) {
        throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} is archived`);
      }

      const agent = await ensureAgentLoaded(schedule.target.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
      if (this.agentManager.hasInFlightRun(agent.id)) {
        throw new Error(`Agent ${agent.id} already has an active run`);
      }
      await startAgentRun(this.agentManager, agent.id, wrappedPrompt, this.logger, {
        replaceRunning: true,
        activeTurnBehavior: "steer",
      });
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
      });
      if (waitResult.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (waitResult.status === "error") {
        throw new Error(waitResult.lastMessage ?? `Scheduled agent ${agent.id} failed`);
      }
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: null,
          timelineText: "",
          finalText: waitResult.lastMessage ?? "",
        }),
      };
    }

    const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
    if (!config) {
      throw new Error(`Schedule ${schedule.id} target changed during execution`);
    }
    await this.assertNewAgentCwdDirectory(config.cwd);
    let workspace: PersistedWorkspaceRecord | null = null;
    let agentId: string | null = null;
    try {
      workspace = await this.createScheduleRunWorkspace(config, schedule.prompt);
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId: null,
      });
      const runConfig = { ...config, cwd: workspace.cwd };
      const created = await this.createAgent({
        kind: "mcp",
        provider: formatScheduleProviderModel(runConfig),
        config: buildScheduleAgentConfig(runConfig),
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: resolveScheduleAgentTitle(config, schedule.prompt),
        labels: {
          "paseo.schedule-id": schedule.id,
          "paseo.schedule-run": runId,
        },
        mode: config.modeId,
        thinking: config.thinkingOptionId,
        features: config.featureValues,
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
      });
      const agent = created.snapshot;
      agentId = agent.id;
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId,
      });
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const result = await this.agentManager.runAgent(agent.id, schedule.prompt);
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
      });
      if (result.canceled) {
        throw new Error(`Scheduled agent ${agent.id} was canceled`);
      }
      if (waitResult.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (waitResult.status === "error") {
        throw new Error(waitResult.lastMessage ?? `Scheduled agent ${agent.id} failed`);
      }
      const timelineText = curateAgentActivity(result.timeline);
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: waitResult.lastMessage ?? null,
          timelineText,
          finalText: result.finalText,
        }),
      };
    } finally {
      if (
        workspace &&
        shouldArchiveScheduleRunWorkspace({ agentId, archiveOnFinish: config.archiveOnFinish })
      ) {
        try {
          await this.archiveWorkspace(workspace.workspaceId);
        } catch (error) {
          this.logger.warn(
            {
              err: error,
              agentId,
              workspaceId: workspace.workspaceId,
              scheduleId: schedule.id,
              runId,
            },
            "Failed to archive scheduled workspace after run",
          );
        }
      }
    }
  }

  private async createScheduleRunWorkspace(
    config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
    prompt: string,
  ): Promise<PersistedWorkspaceRecord> {
    const firstAgentContext = { prompt };
    switch (config.isolation ?? "local") {
      case "local":
        return this.createDirectoryWorkspace({ cwd: config.cwd, firstAgentContext });
      case "worktree":
        return (await this.createPaseoWorktreeWorkspace({ cwd: config.cwd, firstAgentContext }))
          .workspace;
    }
  }

  private async assertNewAgentCwdDirectory(cwd: string): Promise<void> {
    try {
      const stats = await stat(cwd);
      if (!stats.isDirectory()) {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} no longer exists`);
      }
      throw error;
    }
  }
}

function buildScheduleAgentConfig(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): AgentSessionConfig {
  return {
    provider: config.provider,
    cwd: config.cwd,
    modeId: config.modeId,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId,
    title: config.title,
    providerOptions: config.providerOptions,
    featureValues: config.featureValues,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers as AgentSessionConfig["mcpServers"],
  };
}

function resolveScheduleAgentTitle(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
  prompt: string,
): string {
  return (
    resolveCreateAgentTitles({
      configTitle: config.title,
      initialPrompt: prompt,
    }).provisionalTitle ?? ""
  );
}

function formatScheduleProviderModel(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): string {
  return formatProviderModel(config.provider, config.model);
}
