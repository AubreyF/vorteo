import { assertWorkspaceUnprotected } from "./workspace-lifecycle/policy.js";
import { promises as fs } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type { Logger } from "pino";
import { z } from "zod";
import {
  WorkspaceFactoryMembershipSchema,
  WorkspaceProjectMembershipSchema,
} from "@getpaseo/protocol/messages";

import { writeJsonFileAtomic } from "./atomic-file.js";
import { areEquivalentPaths } from "../utils/path.js";
import {
  generateProjectId,
  type PersistedProjectKind,
  type PersistedWorkspaceKind,
} from "./workspace-registry-model.js";
import type { UntrustedWorkspaceSource } from "./workspace-automation-gate.js";
import {
  FactoryInstallCheckpointSchema,
  FactoryInstallCheckpointError,
  type FactoryInstallCheckpoint,
} from "./factory/install-checkpoint.js";

const UntrustedWorkspaceSourceSchema = z.object({
  kind: z.literal("change_request"),
  forge: z.string(),
  number: z.number().int().positive(),
  headRepository: z.string(),
});

const PersistedProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["git", "non_git"]),
  displayName: z.string(),
  // COMPAT(projectKey): added in v0.2.4 on 2026-07-28; remove optional after 2027-01-28.
  projectKey: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // User-set override layered over the derived displayName. Reconciliation
  // never touches this. Null means "use the derived name". Added for #987.
  customName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Identifies the project's stored custom icon; null means automatic.
  customIconRevision: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  factoryInstallation: FactoryInstallCheckpointSchema.optional(),
});

const PersistedWorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  projectMembership: WorkspaceProjectMembershipSchema.nullable().optional(),
  // Native installation lifecycle owns this relationship; ordinary requests cannot set it.
  factoryMembership: WorkspaceFactoryMembershipSchema.optional(),
  cwd: z.string(),
  kind: z.enum(["local_checkout", "worktree", "directory"]),
  displayName: z.string(),
  // User-set title layered over the derived displayName. In Model B the title is
  // the workspace identity; branch/directory are backing metadata. Reconciliation
  // never touches this. Null means "use the derived displayName".
  title: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // The worktree's git branch. Decoupled from displayName/title by construction:
  // displayName holds the human name (title), branch holds the git branch. Only
  // worktree workspaces carry a branch; directory/local_checkout leave it null.
  branch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Exact checkout/worktree root backing cwd. This differs from cwd when the
  // selected project is a subdirectory inside a repository. Persist it so
  // archive and recovery do not need the directory to still exist in order to
  // recover placement.
  worktreeRoot: z.string().nullable().default(null),
  // Comparison base preserved across worktree deletion and restore. New branch-off
  // workspaces store the resolved ref (e.g. refs/remotes/upstream/main); legacy and
  // PR checkout records may contain a bare branch name. Ordinary checkouts use null.
  baseBranch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  isPaseoOwnedWorktree: z.boolean().default(false),
  mainRepoRoot: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  // COMPAT(autoArchivedChangeRequestUrl): added in v0.2.6, remove optional parsing after 2027-01-31.
  // Records the merged change request whose automatic archive was consumed.
  autoArchivedChangeRequestUrl: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  pinnedAt: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  labels: z.array(z.string()).optional(),
  standing: z.boolean().optional(),
  protected: z.boolean().optional(),
  untrustedSource: UntrustedWorkspaceSourceSchema.optional(),
});

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;

export interface WorkspaceMutation {
  kind: "upsert" | "archive" | "remove";
  workspaceId: string;
  workspace: PersistedWorkspaceRecord | null;
  expectsInitialAgent?: boolean;
}

export interface WorkspaceMutationContext {
  expectsInitialAgent?: boolean;
}

export interface WorkspaceArchiveContext {
  autoArchivedChangeRequestUrl?: string;
}

export interface ProjectMutation {
  kind: "upsert" | "archive" | "remove";
  projectId: string;
  project: PersistedProjectRecord | null;
}

export interface ProjectRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedProjectRecord[]>;
  get(projectId: string): Promise<PersistedProjectRecord | null>;
  getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    projectKey?: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord>;
  upsert(record: PersistedProjectRecord): Promise<void>;
  update(
    projectId: string,
    updater: (record: PersistedProjectRecord) => PersistedProjectRecord,
  ): Promise<PersistedProjectRecord | null>;
  archive(projectId: string, archivedAt: string): Promise<void>;
  remove(projectId: string): Promise<void>;
  /** Central lifecycle seam for daemon-global project observers. */
  subscribeToMutations?(listener: (mutation: ProjectMutation) => void | Promise<void>): () => void;
}

export interface WorkspaceRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedWorkspaceRecord[]>;
  get(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null>;
  upsert(record: PersistedWorkspaceRecord, context?: WorkspaceMutationContext): Promise<void>;
  archive(
    workspaceId: string,
    archivedAt: string,
    context?: WorkspaceArchiveContext,
  ): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  /** Native-only binding seam; role reservation and record comparison share one transaction. */
  bindFactoryMember?(input: {
    expected: PersistedWorkspaceRecord;
    membership: NonNullable<PersistedWorkspaceRecord["factoryMembership"]>;
    assertCurrent(): void;
  }): Promise<PersistedWorkspaceRecord | null>;
  /** Central lifecycle seam for daemon-global workspace observers. */
  subscribeToMutations?(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void;
}

type RegistryRecord = PersistedProjectRecord | PersistedWorkspaceRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  protected readonly logger: Logger;
  private readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationsBlockedUntilRestart = false;
  private readonly writeRecords: (filePath: string, records: readonly TRecord[]) => Promise<void>;

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: z.ZodType<TRecord, unknown>;
    getId: (record: TRecord) => string;
    component: string;
    writeRecords?: (filePath: string, records: readonly TRecord[]) => Promise<void>;
  }) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getId = options.getId;
    this.logger = options.logger.child({
      module: "workspace-registry",
      component: options.component,
    });
    this.writeRecords = options.writeRecords ?? writeJsonFileAtomic;
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<TRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  /** Native lifecycle guards must recheck initialized identity without yielding. */
  getLoadedRecord(id: string): TRecord | null {
    if (!this.loaded) throw new Error("Workspace registry has not been initialized.");
    return this.cache.get(id) ?? null;
  }

  async upsert(record: TRecord): Promise<void> {
    const parsed = this.schema.parse(record);
    await this.mutateCache((records) => {
      records.set(this.getId(parsed), parsed);
      return undefined;
    });
  }

  async update(id: string, updater: (record: TRecord) => TRecord): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      const next = this.schema.parse(updater(existing));
      records.set(id, next);
      return next;
    });
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.archiveIfPresent(id, archivedAt);
  }

  protected async archiveIfPresent(id: string, archivedAt: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      const next = this.schema.parse({ ...existing, updatedAt: archivedAt, archivedAt });
      records.set(id, next);
      return next;
    });
  }

  protected async archiveIfActive(id: string, archivedAt: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing || existing.archivedAt) return null;
      const next = this.schema.parse({ ...existing, updatedAt: archivedAt, archivedAt });
      records.set(id, next);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.removeIfPresent(id);
  }

  protected async removeIfPresent(id: string): Promise<TRecord | null> {
    return this.mutateCache((records) => {
      const existing = records.get(id);
      if (!existing) return null;
      records.delete(id);
      return existing;
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = z.array(this.schema).parse(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(this.getId(record), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load registry file");
      }
    }
    this.loaded = true;
  }

  protected async mutateMany(
    updater: (records: ReadonlyMap<string, TRecord>) => readonly TRecord[],
  ): Promise<TRecord[]> {
    return this.mutateCache((records) => {
      const changed = updater(records);
      if (changed.length === 0) return [];
      const parsed = changed.map((record) => this.schema.parse(record));
      for (const record of parsed) records.set(this.getId(record), record);
      return parsed;
    });
  }

  protected async mutateCache<TResult>(
    updater: (records: Map<string, TRecord>) => TResult,
    hooks?: {
      forcePersist?: (result: TResult) => boolean;
      beforeWrite?: (records: readonly TRecord[]) => Promise<void>;
      afterWrite?: () => Promise<void>;
      afterCommit?: () => void;
    },
  ): Promise<TResult> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.load();
      if (this.mutationsBlockedUntilRestart) {
        throw new Error("Workspace registry mutations are blocked until daemon restart");
      }
      const staged = new Map(this.cache);
      const result = updater(staged);
      const recordsChanged = !mapsEqual(this.cache, staged);
      if (!recordsChanged && !hooks?.forcePersist?.(result)) return result;
      const records = Array.from(staged.values());
      await hooks?.beforeWrite?.(records);
      if (recordsChanged) await this.writeRecords(this.filePath, records);
      await hooks?.afterWrite?.();
      if (recordsChanged) {
        this.cache.clear();
        for (const [id, record] of staged) this.cache.set(id, record);
      }
      hooks?.afterCommit?.();
      return result;
    } finally {
      release();
    }
  }

  protected freezeMutationsUntilRestart(): void {
    this.mutationsBlockedUntilRestart = true;
  }
}

function mapsEqual<TKey, TValue>(left: Map<TKey, TValue>, right: Map<TKey, TValue>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export class FileBackedProjectRegistry
  extends FileBackedRegistry<PersistedProjectRecord>
  implements ProjectRegistry
{
  private allocationQueue: Promise<void> = Promise.resolve();
  private readonly projectIdFactory: () => string;
  private readonly mutationListeners = new Set<
    (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>
  >();

  constructor(
    filePath: string,
    logger: Logger,
    options?: {
      projectIdFactory?: () => string;
      writeRecords?: (
        filePath: string,
        records: readonly PersistedProjectRecord[],
      ) => Promise<void>;
    },
  ) {
    super({
      filePath,
      logger,
      schema: PersistedProjectRecordSchema,
      getId: (record) => record.projectId,
      component: "projects",
      writeRecords: options?.writeRecords,
    });
    this.projectIdFactory = options?.projectIdFactory ?? generateProjectId;
  }

  override async get(projectId: string): Promise<PersistedProjectRecord | null> {
    return structuredClone(await super.get(projectId));
  }

  override async list(): Promise<PersistedProjectRecord[]> {
    return structuredClone(await super.list());
  }

  override getLoadedRecord(projectId: string): PersistedProjectRecord | null {
    return structuredClone(super.getLoadedRecord(projectId));
  }

  async getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    projectKey?: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord> {
    const previous = this.allocationQueue;
    let release!: () => void;
    this.allocationQueue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const active = (await this.list())
        .filter(
          (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, input.rootPath),
        )
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.projectId.localeCompare(right.projectId),
        )[0];
      if (active) {
        if (active.kind === input.kind && active.projectKey === (input.projectKey ?? null))
          return active;
        const refreshed = {
          ...active,
          kind: input.kind,
          projectKey: input.projectKey ?? null,
          updatedAt: input.timestamp,
        };
        await this.upsert(refreshed);
        return refreshed;
      }

      for (;;) {
        const projectId = this.projectIdFactory();
        if (await this.get(projectId)) continue;
        const record = createPersistedProjectRecord({
          projectId,
          rootPath: input.rootPath,
          kind: input.kind,
          displayName: input.displayName,
          projectKey: input.projectKey ?? null,
          createdAt: input.timestamp,
          updatedAt: input.timestamp,
        });
        await this.upsert(record);
        return record;
      }
    } finally {
      release();
    }
  }

  subscribeToMutations(
    listener: (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  override async upsert(record: PersistedProjectRecord): Promise<void> {
    await this.mutateCache((records) => {
      const existing = records.get(record.projectId);
      if (!isDeepStrictEqual(existing?.factoryInstallation, record.factoryInstallation))
        throw new Error("Factory installation state requires the native installation operation.");
      records.set(record.projectId, PersistedProjectRecordSchema.parse(record));
    });
    await this.notifyMutation({ kind: "upsert", projectId: record.projectId, project: record });
  }

  override async update(
    projectId: string,
    updater: (record: PersistedProjectRecord) => PersistedProjectRecord,
  ): Promise<PersistedProjectRecord | null> {
    const project = await super.update(projectId, (record) => {
      const next = updater(structuredClone(record));
      if (!isDeepStrictEqual(record.factoryInstallation, next.factoryInstallation))
        throw new Error("Factory installation state requires the native installation operation.");
      return next;
    });
    if (!project) return null;
    await this.notifyMutation({ kind: "upsert", projectId, project });
    return structuredClone(project);
  }

  override async archive(projectId: string, archivedAt: string): Promise<void> {
    const project = await this.mutateCache((records) => {
      const current = records.get(projectId);
      if (!current || current.archivedAt) return null;
      if (current.factoryInstallation)
        throw new Error("Factory installation requires reconciled owner disable before archive.");
      const next = PersistedProjectRecordSchema.parse({
        ...current,
        updatedAt: archivedAt,
        archivedAt,
      });
      records.set(projectId, next);
      return structuredClone(next);
    });
    if (!project) return;
    await this.notifyMutation({ kind: "archive", projectId, project });
  }

  override async remove(projectId: string): Promise<void> {
    const project = await this.mutateCache((records) => {
      const current = records.get(projectId);
      if (!current) return null;
      if (current.factoryInstallation)
        throw new Error("Factory installation requires reconciled owner disable before removal.");
      records.delete(projectId);
      return current;
    });
    if (!project) return;
    await this.notifyMutation({ kind: "remove", projectId, project: null });
  }

  /** Startup-owned installer only; any retained checkpoint blocks a new attempt. */
  async beginFactoryInstallation(input: {
    expected: PersistedProjectRecord;
    checkpoint: FactoryInstallCheckpoint;
    assertCurrent(): void;
  }): Promise<PersistedProjectRecord> {
    if (input.checkpoint.stage !== "binding" || input.expected.factoryInstallation)
      throw new Error("Factory installation already requires reconciliation.");
    return this.persistFactoryInstallation(input);
  }

  async completeFactoryInstallation(input: {
    expected: PersistedProjectRecord;
    checkpoint: FactoryInstallCheckpoint;
    assertCurrent(): void;
  }): Promise<PersistedProjectRecord> {
    const pending = input.expected.factoryInstallation;
    const sameBinding =
      pending?.stage === "binding" &&
      input.checkpoint.stage === "attached" &&
      isDeepStrictEqual(
        { ...pending, stage: "attached", revision: input.checkpoint.revision },
        input.checkpoint,
      );
    if (!sameBinding || pending?.revision === input.checkpoint.revision)
      throw new Error("Factory installation completion does not match its retained attempt.");
    return this.persistFactoryInstallation(input);
  }

  private async persistFactoryInstallation(input: {
    expected: PersistedProjectRecord;
    checkpoint: FactoryInstallCheckpoint;
    assertCurrent(): void;
  }): Promise<PersistedProjectRecord> {
    const expected = structuredClone(input.expected);
    const checkpoint = FactoryInstallCheckpointSchema.parse(input.checkpoint);
    const assertOwner = input.assertCurrent;
    function assertCurrent(): void {
      assertOwner();
      if (
        input.assertCurrent !== assertOwner ||
        !isDeepStrictEqual(input.expected, expected) ||
        !isDeepStrictEqual(input.checkpoint, checkpoint)
      )
        throw new Error("Factory installation invocation changed before persistence.");
    }
    if (
      checkpoint.projectId !== expected.projectId ||
      expected.archivedAt ||
      expected.kind !== "git"
    )
      throw new Error("Factory installation project identity is unavailable.");
    let writeAttempted = false;
    try {
      const next = await this.mutateCache(
        (records) => {
          assertCurrent();
          const current = records.get(expected.projectId);
          if (!isDeepStrictEqual(current, expected))
            throw new Error("Factory installation project changed before persistence.");
          const updated = PersistedProjectRecordSchema.parse({
            ...expected,
            factoryInstallation: checkpoint,
          });
          records.set(expected.projectId, updated);
          return updated;
        },
        {
          beforeWrite: async () => {
            assertCurrent();
            writeAttempted = true;
          },
          afterCommit: assertCurrent,
        },
      );
      await this.notifyMutation({ kind: "upsert", projectId: next.projectId, project: next });
      return structuredClone(next);
    } catch (error) {
      if (!writeAttempted) throw error;
      this.freezeMutationsUntilRestart();
      throw new FactoryInstallCheckpointError(
        checkpoint.operationId,
        checkpoint.installationId,
        error,
      );
    }
  }

  private async notifyMutation(mutation: {
    kind: "upsert" | "archive" | "remove";
    projectId: string;
    project: PersistedProjectRecord | null;
  }): Promise<void> {
    await Promise.all(
      [...this.mutationListeners].map((listener) => listener(structuredClone(mutation))),
    );
  }
}

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  private readonly mutationListeners = new Set<
    (mutation: WorkspaceMutation) => void | Promise<void>
  >();

  private readonly assertArchiveAllowed?: (workspaceId: string) => Promise<void>;

  constructor(
    filePath: string,
    logger: Logger,
    options?: {
      assertArchiveAllowed?: (workspaceId: string) => Promise<void>;
      writeRecords?: (
        filePath: string,
        records: readonly PersistedWorkspaceRecord[],
      ) => Promise<void>;
    },
  ) {
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
      writeRecords: options?.writeRecords,
    });
    this.assertArchiveAllowed = options?.assertArchiveAllowed;
  }

  subscribeToMutations(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  override async update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null> {
    const workspace = await super.update(workspaceId, updater);
    if (workspace) {
      await this.notifyMutation({ kind: "upsert", workspaceId, workspace });
    }
    return workspace;
  }

  async bindFactoryMember(input: {
    expected: PersistedWorkspaceRecord;
    membership: NonNullable<PersistedWorkspaceRecord["factoryMembership"]>;
    assertCurrent(): void;
  }): Promise<PersistedWorkspaceRecord | null> {
    const membership = WorkspaceFactoryMembershipSchema.parse(input.membership);
    const workspace = await this.mutateCache((records) => {
      input.assertCurrent();
      const current = records.get(input.expected.workspaceId);
      if (!current) return null;
      if (!isDeepStrictEqual(current, input.expected))
        throw new Error("Workspace changed before Factory binding.");
      if (current.archivedAt || membership.projectId !== current.projectId)
        throw new Error("Factory workspace is archived or belongs to another project.");
      if (current.factoryMembership) {
        if (!isDeepStrictEqual(current.factoryMembership, membership))
          throw new Error("Workspace already belongs to a different Factory relationship.");
      }
      // Include archived members: retained ownership is not a vacant role.
      for (const retained of records.values()) {
        if (retained.workspaceId === current.workspaceId) continue;
        const binding = retained.factoryMembership;
        if (retained.projectId !== current.projectId || !binding) continue;
        if (binding.projectId !== retained.projectId || binding.serverId !== membership.serverId)
          throw new Error("Retained Factory membership does not match this host and project.");
        if (binding.installationId !== membership.installationId)
          throw new Error("Project already belongs to another Factory installation.");
        if (membership.role !== "worker" && binding.role === membership.role)
          throw new Error("Factory coordinator role already has a retained workspace.");
      }
      if (current.factoryMembership) return current;
      const bound = {
        ...current,
        factoryMembership: membership,
        updatedAt: new Date().toISOString(),
      };
      records.set(current.workspaceId, bound);
      return bound;
    });
    if (workspace) {
      await this.notifyMutation({ kind: "upsert", workspaceId: workspace.workspaceId, workspace });
    }
    return workspace;
  }

  override async upsert(
    record: PersistedWorkspaceRecord,
    context?: WorkspaceMutationContext,
  ): Promise<void> {
    await super.upsert(record);
    await this.notifyMutation({
      kind: "upsert",
      workspaceId: record.workspaceId,
      workspace: record,
      ...(context?.expectsInitialAgent ? { expectsInitialAgent: true } : {}),
    });
  }

  override async archive(
    workspaceId: string,
    archivedAt: string,
    context?: WorkspaceArchiveContext,
  ): Promise<void> {
    await this.assertArchiveAllowed?.(workspaceId);
    const workspace = await super.update(workspaceId, (existing) => {
      assertWorkspaceUnprotected(existing);
      return {
        ...existing,
        updatedAt: archivedAt,
        archivedAt,
        ...(context?.autoArchivedChangeRequestUrl
          ? { autoArchivedChangeRequestUrl: context.autoArchivedChangeRequestUrl }
          : {}),
      };
    });
    if (!workspace) return;
    await this.notifyMutation({ kind: "archive", workspaceId, workspace });
  }

  override async remove(workspaceId: string): Promise<void> {
    await this.assertArchiveAllowed?.(workspaceId);
    const workspace = await this.mutateCache((records) => {
      const existing = records.get(workspaceId);
      if (!existing) return null;
      assertWorkspaceUnprotected(existing);
      records.delete(workspaceId);
      return existing;
    });
    if (!workspace) return;
    await this.notifyMutation({ kind: "remove", workspaceId, workspace: null });
  }

  async commitWorkspaceLabelMutation<TResult>(input: {
    stage: (records: ReadonlyMap<string, PersistedWorkspaceRecord>) => {
      updates: readonly PersistedWorkspaceRecord[];
      result: TResult;
      forcePersist: boolean;
    };
    beforeWorkspaceWrite: (records: readonly PersistedWorkspaceRecord[]) => Promise<void>;
    afterWorkspaceWrite: () => Promise<void>;
    afterCommit: () => void;
    publish?: boolean;
  }): Promise<TResult> {
    let changed: PersistedWorkspaceRecord[] = [];
    const committed = await this.mutateCache(
      (records) => {
        const staged = input.stage(records);
        changed = staged.updates.map((record) => PersistedWorkspaceRecordSchema.parse(record));
        for (const record of changed) records.set(record.workspaceId, record);
        return { result: staged.result, forcePersist: staged.forcePersist };
      },
      {
        forcePersist: (output) => output.forcePersist,
        beforeWrite: input.beforeWorkspaceWrite,
        afterWrite: input.afterWorkspaceWrite,
        afterCommit: input.afterCommit,
      },
    );
    if (input.publish !== false) {
      await Promise.all(
        changed.map((workspace) =>
          this.notifyMutation({ kind: "upsert", workspaceId: workspace.workspaceId, workspace }),
        ),
      );
    }
    return committed.result;
  }

  blockAllMutationsUntilRestart(): void {
    this.freezeMutationsUntilRestart();
  }

  private async notifyMutation(mutation: WorkspaceMutation): Promise<void> {
    await Promise.all(
      [...this.mutationListeners].map(async (listener) => {
        try {
          await listener(mutation);
        } catch (error) {
          // Publication happens after the registry commit and cannot make durable state fail.
          this.logger.error({ err: error, mutation }, "Workspace mutation listener failed");
        }
      }),
    );
  }
}

export function createPersistedProjectRecord(input: {
  projectId: string;
  rootPath: string;
  kind: PersistedProjectKind;
  displayName: string;
  customName?: string | null;
  projectKey?: string | null;
  customIconRevision?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return PersistedProjectRecordSchema.parse({
    ...input,
    customName: input.customName ?? null,
    projectKey: input.projectKey ?? null,
    customIconRevision: input.customIconRevision ?? null,
    archivedAt: input.archivedAt ?? null,
  });
}

export function resolveProjectDisplayName(record: PersistedProjectRecord): string {
  return record.customName ?? record.displayName;
}

export function createPersistedWorkspaceRecord(input: {
  projectMembership?: PersistedWorkspaceRecord["projectMembership"];
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceKind;
  displayName: string;
  title?: string | null;
  branch?: string | null;
  worktreeRoot?: string | null;
  baseBranch?: string | null;
  isPaseoOwnedWorktree?: boolean;
  mainRepoRoot?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  autoArchivedChangeRequestUrl?: string | null;
  pinnedAt?: string | null;
  labels?: string[];
  untrustedSource?: UntrustedWorkspaceSource;
}): PersistedWorkspaceRecord {
  return PersistedWorkspaceRecordSchema.parse({
    ...input,
    title: input.title ?? null,
    branch: input.branch ?? null,
    worktreeRoot: input.worktreeRoot ?? null,
    baseBranch: input.baseBranch ?? null,
    isPaseoOwnedWorktree: input.isPaseoOwnedWorktree ?? false,
    mainRepoRoot: input.mainRepoRoot ?? null,
    archivedAt: input.archivedAt ?? null,
    autoArchivedChangeRequestUrl: input.autoArchivedChangeRequestUrl ?? null,
    pinnedAt: input.pinnedAt ?? null,
  });
}

// The single workspace-name rule: the title always wins; otherwise fall back to
// the freshest available derived display name (a live branch snapshot when the
// caller has one, the persisted displayName otherwise).
export function resolveWorkspaceName(input: {
  title: string | null;
  derivedDisplayName: string;
}): string {
  return input.title ?? input.derivedDisplayName;
}

export function resolveWorkspaceDisplayName(record: PersistedWorkspaceRecord): string {
  return resolveWorkspaceName({ title: record.title, derivedDisplayName: record.displayName });
}
