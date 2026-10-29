import { blockedReviewDue } from "./task-checklist/blocked-review.js";
import {
  AgentJournalEntrySchema,
  AppendJournalSchema,
  type AgentJournalEntry,
  type AppendJournalInput,
} from "@getpaseo/protocol/agent-journal";
import { JournalError } from "./journal/model.js";
import {
  AgentQuestionSchema,
  type AgentQuestion,
  type QuestionMutation,
} from "@getpaseo/protocol/agent-questions";
import {
  answerQuestion,
  markAnswerDelivered,
  mutateQuestions,
  QuestionError,
  type AnsweredQuestions,
} from "./questions/model.js";
import { AgentTaskItemSchema } from "@getpaseo/protocol/messages";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import {
  mutateChecklist,
  mergeProviderChecklist,
  ChecklistError,
  type ChecklistMutation,
} from "./task-checklist/model.js";
import { SkillSnapshotSchema } from "@getpaseo/protocol/skill-library";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Logger } from "pino";
import { QueueGoalHoldSchema, type QueueGoalHold } from "../message-queue/goal-hold.js";
import {
  ProfileSwitchRecordSchema,
  SwitchHistorySchema,
  type SwitchHistory,
} from "./profile-switch/history.js";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentProfileLaunchSchema } from "@getpaseo/protocol/messages";
import {
  QuotaReserveConfigSchema,
  parseQuotaReservePolicy,
  type QuotaReserveConfig,
} from "@getpaseo/protocol/quota-reserve";
import { UsageLimitHoldSchema } from "@getpaseo/protocol/usage-limit";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    controllerExecutionId: z.string().uuid().optional(),
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    profileLaunch: AgentProfileLaunchSchema.optional(),
    skillSnapshot: SkillSnapshotSchema.optional(),
    quotaPausedAt: z.string().optional(),
    quotaResetAt: z.string().optional(),
    usageLimitHold: UsageLimitHoldSchema.optional(),
    quotaReserve: QuotaReserveConfigSchema.optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

export const GoalSubmissionSchema = z.object({
  text: z.string(),
  clientMessageId: z.string(),
  messageId: z.string().optional(),
  timestamp: z.string(),
});
export type GoalSubmission = z.infer<typeof GoalSubmissionSchema>;

const STORED_AGENT_SCHEMA = z.object({
  journal: z.array(AgentJournalEntrySchema).optional(),
  questions: z.array(AgentQuestionSchema).optional(),
  tasks: z.array(AgentTaskItemSchema).optional(),
  goalSubmissions: z.array(GoalSubmissionSchema).optional(),
  profileSwitches: z.array(ProfileSwitchRecordSchema).optional(),
  // Discovery hint only. Admission always re-reads the native goal.
  blockedGoalReviewNeeded: z.boolean().optional(),
  queueGoalHold: QueueGoalHoldSchema.optional(),
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastBlockedReviewAt: z.string().datetime().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "controllerExecutionId"
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "profileLaunch"
  | "skillSnapshot"
  | "quotaPausedAt"
  | "quotaResetAt"
  | "usageLimitHold"
  | "quotaReserve"
  | "mcpServers"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  const record = STORED_AGENT_SCHEMA.parse(value);
  if (record.config?.quotaReserve) {
    parseQuotaReservePolicy(record.config.quotaReserve.policy);
  }
  return record;
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  // Entries already durable in each agent's journal sidecar. Journals are append-only.
  private persistedJournalLength: Map<string, number> = new Map();
  // Agents whose journal file exists but could not be read this run, for example after a
  // permission or I/O error. Their records keep any inline journal and refuse appends, so
  // a fresh journal can never replace one that is merely unreachable.
  private unavailableJournals: Set<string> = new Set();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async list(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.getLoadedRecord(agentId);
  }

  // Synchronous admission must consult the initialized store without yielding
  // between checking a supervisor's stop state and admitting its worker.
  getLoadedRecord(agentId: string): StoredAgentRecord | null {
    if (!this.loaded) throw new Error("Agent storage has not been initialized.");
    return this.cache.get(agentId) ?? null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter((record) => record.workspaceId === workspaceId);
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  /** Written before the switch commits; an orphan from a failed switch is never read. */
  async writeSwitchHistory(agentId: string, history: SwitchHistory): Promise<void> {
    await writeJsonFileAtomic(this.switchHistoryPath(agentId, history.switchId), history);
  }

  async readSwitchHistory(agentId: string, switchId: string): Promise<SwitchHistory> {
    const content = await fs.readFile(this.switchHistoryPath(agentId, switchId), "utf8");
    return SwitchHistorySchema.parse(JSON.parse(content));
  }

  // Outside baseDir, whose subdirectories are scanned as agent records.
  private switchHistoryDir(agentId: string): string {
    return path.join(path.dirname(this.baseDir), "agent-switch-history", agentId);
  }

  private switchHistoryPath(agentId: string, switchId: string): string {
    return path.join(this.switchHistoryDir(agentId), `${encodeURIComponent(switchId)}.json`);
  }

  // The journal lives in a sidecar so frequent snapshot writes do not reserialize
  // it; it is rewritten only when an entry is appended. Older daemons ignore the
  // sidecar, so after a rollback the journal looks empty until the next upgrade,
  // but nothing is lost: entries an older daemon appends inline are merged on load.
  private journalPath(agentId: string): string {
    return path.join(
      path.dirname(this.baseDir),
      "agent-journals",
      `${encodeURIComponent(agentId)}.json`,
    );
  }

  private async readJournalSidecar(agentId: string): Promise<AgentJournalEntry[] | null> {
    let content: string;
    try {
      content = await fs.readFile(this.journalPath(agentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return z.array(AgentJournalEntrySchema).parse(JSON.parse(content));
    } catch (error) {
      throw new CorruptJournalError(error);
    }
  }

  private async attachJournal(record: StoredAgentRecord): Promise<StoredAgentRecord> {
    let sidecar: AgentJournalEntry[] | null;
    try {
      sidecar = await this.readJournalSidecar(record.id);
    } catch (error) {
      if (!(error instanceof CorruptJournalError)) {
        this.unavailableJournals.add(record.id);
        this.logger.error(
          { err: error, agentId: record.id, filePath: this.journalPath(record.id) },
          "Agent journal could not be read; appends are refused until the daemon reloads it",
        );
        return record;
      }
      // Keep the corrupt file for recovery; the next journal save would replace it.
      const filePath = this.journalPath(record.id);
      const preservedPath = `${filePath}.unreadable-${Date.now()}`;
      await fs.rename(filePath, preservedPath).catch(() => undefined);
      this.logger.error(
        { err: error, agentId: record.id, filePath, preservedPath },
        "Ignoring unreadable agent journal; the inline journal is used instead",
      );
      return record;
    }
    if (!sidecar) return record;
    this.persistedJournalLength.set(record.id, sidecar.length);
    const ids = new Set(sidecar.map((entry) => entry.id));
    // Entries an older daemon appended inline restart at sequence 1; renumber them after
    // the journal file so sequences stay unique and ordered.
    const journal = [...sidecar];
    for (const entry of record.journal ?? []) {
      if (!ids.has(entry.id)) journal.push({ ...entry, sequence: journal.length + 1 });
    }
    return { ...record, journal: journal.length > 0 ? journal : record.journal };
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    await this.queueRecordWrite(record);
  }

  async updateQueueGoalHold(
    agentId: string,
    queueGoalHold: QueueGoalHold | undefined,
  ): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) =>
      record ? { ...record, queueGoalHold } : null,
    );
  }

  /** Exact-record mutation for reconciled recovery, not an execution permit. */
  async clearRetainedArchive(
    expected: StoredAgentRecord,
    assertCurrent: () => void,
  ): Promise<StoredAgentRecord> {
    const captured = structuredClone(expected);
    await this.load();
    let committed: StoredAgentRecord | null = null;
    await this.queueRecordMutation(captured.id, (current) => {
      assertCurrent();
      if (!current?.archivedAt || !isDeepStrictEqual(current, captured))
        throw new Error("Retained agent changed before archive-state recovery.");
      committed = { ...current, archivedAt: null, updatedAt: new Date().toISOString() };
      return committed;
    });
    if (!committed) throw new Error("Retained agent is being deleted.");
    // A failed post-write assertion is a partial result, never a safe retry.
    assertCurrent();
    return structuredClone(committed);
  }

  async updateQuotaReserve(
    agentId: string,
    update: (current: QuotaReserveConfig) => QuotaReserveConfig,
  ): Promise<QuotaReserveConfig | null> {
    await this.load();
    let committed: QuotaReserveConfig | null = null;
    await this.queueRecordMutation(agentId, (record) => {
      if (!record || record.archivedAt || record.config?.quotaPausedAt) return null;
      const current = record.config?.quotaReserve;
      if (!current) throw new Error("This task has no quota reserve policy.");
      committed = update(current);
      return { ...record, config: { ...record.config, quotaReserve: committed } };
    });
    return committed;
  }

  private queueRecordWrite(record: StoredAgentRecord): Promise<void> {
    return this.queueRecordMutation(record.id, () => record);
  }

  async claimBlockedReview(agentId: string, now: number): Promise<boolean> {
    await this.load();
    let claimed = false;
    await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record || !blockedReviewDue(record, now)) return null;
        claimed = true;
        return { ...record, lastBlockedReviewAt: new Date(now).toISOString() };
      },
      { blockedReviewWrite: true },
    );
    return claimed;
  }

  async updateBlockedGoalReview(agentId: string, needed: boolean): Promise<void> {
    await this.load();
    await this.queueRecordMutation(
      agentId,
      (record) => (record ? { ...record, blockedGoalReviewNeeded: needed } : null),
      { goalReviewWrite: true },
    );
  }

  async appendJournal(agentId: string, input: AppendJournalInput): Promise<AgentJournalEntry> {
    const { entryId, text, machineContext } = AppendJournalSchema.parse(input);
    await this.load();
    let committed: AgentJournalEntry | null = null;
    await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record || record.archivedAt)
          throw new JournalError("not_found", "Only an active thread can append to its journal.");
        if (this.unavailableJournals.has(agentId))
          throw new JournalError(
            "unavailable",
            "This thread's journal could not be read, so new entries cannot be saved safely.",
          );
        const entries = record.journal ?? [];
        const previous = entries.find((entry) => entry.id === entryId);
        if (previous) {
          if (previous.text !== text || previous.machineContext !== machineContext)
            throw new JournalError(
              "conflict",
              "This entry ID was already used for different text or machine context. Journal entries cannot be edited.",
            );
          committed = previous;
          return null;
        }
        committed = {
          id: entryId,
          sequence: entries.length + 1,
          timestamp: new Date().toISOString(),
          text,
          ...(machineContext === undefined ? {} : { machineContext }),
        };
        return { ...record, journal: [...entries, committed] };
      },
      { journalWrite: true },
    );
    if (committed === null)
      throw new JournalError(
        "not_found",
        "The thread was deleted before the journal entry could be saved.",
      );
    return structuredClone(committed);
  }

  async mutateQuestions(agentId: string, mutation: QuestionMutation): Promise<AgentQuestion[]> {
    await this.load();
    let committed: AgentQuestion[] | null = null;
    await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record || record.archivedAt)
          throw new QuestionError("not_found", "Only an active thread can ask questions.");
        const taskIds = new Set(
          (record.tasks ?? []).flatMap((task) =>
            task.source === "vorteo" && task.id ? [task.id] : [],
          ),
        );
        const questions = record.questions ?? [];
        committed = mutateQuestions(questions, mutation, {
          askedBy: agentId,
          now: new Date().toISOString(),
          taskIds,
        });
        return committed === questions ? null : { ...record, questions: committed };
      },
      { questionsWrite: true },
    );
    if (committed === null)
      throw new QuestionError("not_found", "The thread was deleted before the question was saved.");
    return structuredClone(committed);
  }

  async answerQuestion(
    agentId: string,
    input: { questionId: string; answer: string; answeredBy: string },
  ): Promise<AnsweredQuestions> {
    await this.load();
    let committed: AnsweredQuestions | null = null;
    await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record || record.archivedAt)
          throw new QuestionError("not_found", "Only an active thread can receive answers.");
        const questions = record.questions ?? [];
        committed = answerQuestion(questions, { ...input, now: new Date().toISOString() });
        return committed.questions === questions
          ? null
          : { ...record, questions: committed.questions };
      },
      { questionsWrite: true },
    );
    if (committed === null)
      throw new QuestionError("not_found", "The thread was deleted before the answer was saved.");
    return structuredClone(committed);
  }

  async markAnswerDelivered(agentId: string, questionId: string): Promise<AgentQuestion[]> {
    await this.load();
    let committed: AgentQuestion[] | null = null;
    await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record) throw new QuestionError("not_found", "Thread not found.");
        const questions = record.questions ?? [];
        committed = markAnswerDelivered(questions, questionId, new Date().toISOString());
        return committed === questions ? null : { ...record, questions: committed };
      },
      { questionsWrite: true },
    );
    if (committed === null)
      throw new QuestionError("not_found", "The thread was deleted before delivery was saved.");
    return structuredClone(committed);
  }

  async mutateChecklist(agentId: string, mutation: ChecklistMutation): Promise<AgentTaskItem[]> {
    await this.load();
    let committed: AgentTaskItem[] | null = null;
    await this.queueRecordMutation(
      agentId,
      (record) => {
        if (!record || record.archivedAt)
          throw new ChecklistError("not_found", "Only an active thread can edit its checklist.");
        committed = mutateChecklist(record.tasks ?? [], mutation);
        return { ...record, tasks: committed, updatedAt: new Date().toISOString() };
      },
      { checklistWrite: true },
    );
    if (committed === null)
      throw new ChecklistError(
        "not_found",
        "The thread was deleted before the checklist could be saved.",
      );
    return committed;
  }

  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
    options: RecordMutationOptions = {},
  ): Promise<void> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        return undefined;
      }

      const existing = this.cache.get(agentId) ?? null;
      const record = mutate(existing);
      if (!record) return undefined;
      preserveOwnedRecordFields({ record, existing, options });
      // Loading sessions and metadata writers can hold snapshots from before
      // a reserve transition. All writes preserve the newest durable revision.
      const reserve = existing?.config?.quotaReserve;
      if (
        reserve &&
        reserve.state.revision >= (record.config?.quotaReserve?.state.revision ?? -1)
      ) {
        record.config = { ...record.config, quotaReserve: reserve };
      }

      // Stale snapshots cannot restore a stop cleared by a confirmed reset.
      const resetAt = [existing?.config?.quotaResetAt, record.config?.quotaResetAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      if (resetAt) {
        record.config = { ...record.config, quotaResetAt: resetAt };
        if (record.config.quotaPausedAt && record.config.quotaPausedAt <= resetAt) {
          delete record.config.quotaPausedAt;
        }
      }
      await this.writeRecord(record);
      return undefined;
    });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    const { journal, ...withoutJournal } = record;
    const journalLength = journal?.length ?? 0;
    if (this.unavailableJournals.has(agentId)) {
      // The journal file is unreachable; keep any inline journal where it was.
      await writeJsonFileAtomic(nextPath, record);
    } else if (journalLength !== (this.persistedJournalLength.get(agentId) ?? 0)) {
      // The sidecar goes first so a crash before the record write loses nothing.
      // Until the record commits, the sidecar may hold an entry the cache rejected,
      // so mark it unknown and let the next write restore it from the cache.
      this.persistedJournalLength.set(agentId, -1);
      await writeJsonFileAtomic(this.journalPath(agentId), journal ?? []);
      await writeJsonFileAtomic(nextPath, withoutJournal);
      this.persistedJournalLength.set(agentId, journalLength);
    } else {
      await writeJsonFileAtomic(nextPath, withoutJournal);
    }
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve());
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") {
            this.logger.warn(
              { err: error, agentId, filePath },
              "Failed to remove agent record file",
            );
          }
        }
      }),
    );
    await fs.rm(this.switchHistoryDir(agentId), { recursive: true, force: true });
    await fs.rm(this.journalPath(agentId), { force: true });
    this.persistedJournalLength.delete(agentId);
    this.unavailableJournals.delete(agentId);

    this.cache.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    await this.load();
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    await this.queueRecordMutation(agent.id, (existing) => {
      const record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Preserve soft-delete/archive status across snapshot flushes. The
      // projection runs inside the per-agent write queue so it cannot commit a
      // stale pre-archive record after the archive mutation.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      return record;
    });
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();
    this.persistedJournalLength.clear();
    this.unavailableJournals.clear();

    try {
      const records = await this.scanDisk();
      this.loaded = true;
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return [];
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
      return [];
    }
  }

  private async scanDisk(): Promise<StoredAgentRecord[]> {
    const records: StoredAgentRecord[] = [];
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      records.push(record);
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }

    return records;
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return await this.attachJournal(parseStoredAgentRecord(parsed));
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

/** The storage directory name for agents whose working directory is `cwd`. */
export function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

/** Background snapshots preserve the checklist's latest committed mutation. */
function preserveManagedChecklist(
  record: StoredAgentRecord,
  existing: StoredAgentRecord | null,
): void {
  if (!existing) return;
  if (record.tasks === undefined && existing.tasks === undefined) return;
  record.tasks = mergeProviderChecklist(record.tasks ?? [], existing.tasks ?? []);
}

interface RecordMutationOptions {
  goalReviewWrite?: boolean;
  checklistWrite?: boolean;
  journalWrite?: boolean;
  questionsWrite?: boolean;
  blockedReviewWrite?: boolean;
}

interface OwnedRecordFields {
  record: StoredAgentRecord;
  existing: StoredAgentRecord | null;
  options: RecordMutationOptions;
}

// Snapshot writers cannot rewrite state owned by dedicated serialized mutations.
function preserveOwnedRecordFields({ record, existing, options }: OwnedRecordFields): void {
  if (!options.goalReviewWrite && existing)
    record.blockedGoalReviewNeeded = existing.blockedGoalReviewNeeded;
  if (!options.journalWrite && existing) record.journal = existing.journal;
  if (!options.questionsWrite && existing) record.questions = existing.questions;
  if (!options.checklistWrite) preserveManagedChecklist(record, existing);
  if (!options.blockedReviewWrite && existing)
    record.lastBlockedReviewAt = existing.lastBlockedReviewAt;
}

class CorruptJournalError extends Error {
  constructor(cause: unknown) {
    super("Agent journal file is not a valid journal", { cause });
    this.name = "CorruptJournalError";
  }
}
