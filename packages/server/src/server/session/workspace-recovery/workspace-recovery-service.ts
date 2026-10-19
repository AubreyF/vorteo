import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WorkspaceRecoveryGuard } from "@getpaseo/protocol/messages";

import { resolveRepositoryDefaultBranch } from "../../../utils/checkout-git.js";
import { createRealpathAwarePathMatcher } from "../../../utils/path.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import {
  createWorktree,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  rollbackCreatedPaseoWorktree,
  type WorktreeSource,
} from "../../../utils/worktree.js";
import { WorktreeRequestError, toWorktreeRequestError } from "../../worktree-errors.js";
import {
  resolveWorkspaceDisplayName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";

/** The registry serializes this comparison with the archive-state mutation. */
export async function unarchiveWorkspaceGuarded(
  registry: WorkspaceRegistry,
  expected: PersistedWorkspaceRecord,
): Promise<void> {
  const updated = await registry.update(expected.workspaceId, (current) => {
    if (!expected.archivedAt || !isDeepStrictEqual(current, expected))
      throw new Error("Workspace recovery record changed before unarchive.");
    return { ...current, archivedAt: null, updatedAt: new Date().toISOString() };
  });
  if (!updated) throw new Error("Workspace recovery record is no longer available.");
}

export type WorkspaceRecoveryAction = "unarchive" | "restore";

function recoveryRecordHash(workspace: PersistedWorkspaceRecord): string {
  return createHash("sha256").update(JSON.stringify(workspace)).digest("hex");
}

export type WorkspaceRecoveryState =
  | {
      kind: "recoverable";
      workspaceId: string;
      workspaceName: string;
      action: WorkspaceRecoveryAction;
      branch: string | null;
      guard?: WorkspaceRecoveryGuard;
    }
  | {
      kind: "unavailable";
      workspaceId: string;
      reason:
        | "workspace_not_found"
        | "workspace_not_archived"
        | "project_not_found"
        | "project_directory_missing"
        | "workspace_directory_missing"
        | "worktree_branch_missing";
      message: string;
    };

export interface WorkspaceRecoveryService {
  inspect(workspaceId: string): Promise<WorkspaceRecoveryState>;
  restore(
    workspaceId: string,
    guard?: WorkspaceRecoveryGuard,
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }>;
}

type RecoveryPlan =
  | {
      kind: "unarchive";
      state: Extract<WorkspaceRecoveryState, { kind: "recoverable" }>;
      workspace: PersistedWorkspaceRecord;
    }
  | {
      kind: "restore";
      state: Extract<WorkspaceRecoveryState, { kind: "recoverable" }>;
      workspace: PersistedWorkspaceRecord;
      sourceRepoRoot: string;
    };

type UnavailableRecoveryState = Extract<WorkspaceRecoveryState, { kind: "unavailable" }>;

export function createWorkspaceRecoveryService(deps: {
  serverId?: string;
  paseoHome: string;
  worktreesRoot?: string;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProject: (projectId: string) => Promise<PersistedProjectRecord | null>;
  isDirectory: (path: string) => Promise<boolean>;
  unarchiveWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  /** Compare this retained snapshot again inside the serialized registry mutation. */
  unarchiveWorkspaceGuarded?: (workspace: PersistedWorkspaceRecord) => Promise<void>;
}): WorkspaceRecoveryService {
  async function resolveRecovery(
    workspaceId: string,
  ): Promise<UnavailableRecoveryState | RecoveryPlan> {
    const workspace = await deps.getWorkspace(workspaceId);
    if (!workspace) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_not_found",
        message: "This workspace is no longer known to the host.",
      };
    }
    if (!workspace.archivedAt) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_not_archived",
        message: "This workspace is not archived, but it is unavailable from the host.",
      };
    }

    const project = await deps.getProject(workspace.projectId);
    if (!project) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_not_found",
        message: "The project for this archived workspace no longer exists.",
      };
    }

    if (await deps.isDirectory(workspace.cwd)) {
      return createRecoveryPlan({ action: "unarchive", workspace });
    }

    if (workspace.kind !== "worktree") {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_directory_missing",
        message: "The archived workspace directory no longer exists and cannot be recreated.",
      };
    }
    // COMPAT(worktreeRestoreMissingMainRepoRoot): records created before v0.1.110
    // lack placement ownership; remove the project-root fallback after 2027-01-17.
    const sourceRepoRoot = workspace.mainRepoRoot ?? project.rootPath;
    if (!(await deps.isDirectory(sourceRepoRoot))) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_directory_missing",
        message: "The source repository needed to restore this worktree no longer exists.",
      };
    }

    return createRecoveryPlan({ action: "restore", workspace, sourceRepoRoot });
  }

  async function inspect(workspaceId: string): Promise<WorkspaceRecoveryState> {
    const resolved = await resolveRecovery(workspaceId);
    if (resolved.kind === "unavailable") return resolved;
    if (resolved.kind !== "unarchive" || !deps.serverId || !deps.unarchiveWorkspaceGuarded)
      return resolved.state;
    const workspace = resolved.workspace;
    if (!workspace.archivedAt) return resolved.state;
    return {
      ...resolved.state,
      guard: {
        action: "unarchive",
        serverId: deps.serverId,
        projectId: workspace.projectId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        archivedAt: workspace.archivedAt,
        updatedAt: workspace.updatedAt,
        recordHash: recoveryRecordHash(workspace),
      },
    };
  }

  async function restore(
    workspaceId: string,
    guard?: WorkspaceRecoveryGuard,
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const resolved = await resolveRecovery(workspaceId);
    if (resolved.kind === "unavailable") {
      throw new Error(resolved.message);
    }

    if (guard) {
      const workspace = structuredClone(resolved.workspace);
      if (
        guard.action !== "unarchive" ||
        resolved.kind !== "unarchive" ||
        deps.serverId !== guard.serverId ||
        workspace.workspaceId !== workspaceId ||
        workspace.projectId !== guard.projectId ||
        workspace.cwd !== guard.cwd ||
        workspace.kind !== guard.kind ||
        workspace.archivedAt !== guard.archivedAt ||
        workspace.updatedAt !== guard.updatedAt ||
        recoveryRecordHash(workspace) !== guard.recordHash
      )
        throw new Error("Workspace recovery action or retained identity changed.");
      const project = await deps.getProject(workspace.projectId);
      if (!project || project.projectId !== workspace.projectId || project.archivedAt)
        throw new Error("Guarded recovery requires the retained project to remain active.");
      if (!deps.unarchiveWorkspaceGuarded)
        throw new Error("Guarded workspace recovery is unavailable.");
      // This checks existence, not an OS-level directory lease. A disappearing
      // directory never triggers recreation and successful unarchive is not admission.
      if (!(await deps.isDirectory(workspace.cwd)))
        throw new Error("Guarded recovery directory is no longer available.");
      await deps.unarchiveWorkspaceGuarded(workspace);
      return { workspaceId, action: "unarchive" };
    }

    if (resolved.kind === "restore") {
      await recreateArchivedWorktree(resolved.workspace, resolved.sourceRepoRoot);
    }
    await deps.unarchiveWorkspace(resolved.workspace);
    return { workspaceId, action: resolved.kind };
  }

  async function recreateArchivedWorktree(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
  ): Promise<void> {
    const source: WorktreeSource = workspace.branch
      ? { kind: "restore", branchName: workspace.branch, baseRef: workspace.baseBranch }
      : {
          kind: "restore-from-base",
          branchName: `restored/${randomUUID().slice(0, 8)}`,
          baseRef: await resolveRecoveryBase(sourceRepoRoot, workspace.baseBranch),
        };

    try {
      await runGitCommand(["worktree", "prune"], { cwd: sourceRepoRoot, timeout: 30_000 });
    } catch {
      // A stale worktree registration is not guaranteed; creation reports any real conflict.
    }

    let previousWorktreePath = workspace.worktreeRoot;
    if (!previousWorktreePath) {
      // COMPAT(worktreeRestoreMissingWorktreeRoot): records created before v0.1.110
      // lack durable backing placement; remove filesystem discovery after 2027-01-17.
      const ownership = await isPaseoOwnedWorktreeCwd(workspace.cwd, {
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
      });
      previousWorktreePath = ownership.allowed
        ? (ownership.worktreePath ?? workspace.cwd)
        : workspace.cwd;
    }

    let recreatedWorktreePath: string;
    try {
      const result = await createWorktree({
        cwd: sourceRepoRoot,
        worktreeSlug: basename(previousWorktreePath),
        source,
        runSetup: false,
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
      });
      recreatedWorktreePath = result.worktreePath;
    } catch (error) {
      throw toWorktreeRequestError(error);
    }

    try {
      const recreatedWorkspacePath = mapWorkspaceCwdToWorktree({
        sourceWorktreePath: previousWorktreePath,
        workspaceCwd: workspace.cwd,
        targetWorktreePath: recreatedWorktreePath,
      });
      if (!createRealpathAwarePathMatcher(workspace.cwd)(recreatedWorkspacePath)) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Recreated worktree diverged from ${workspace.cwd}: ${recreatedWorkspacePath}`,
        });
      }
      if (!(await deps.isDirectory(recreatedWorkspacePath))) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Selected project directory is missing from the restored worktree: ${recreatedWorkspacePath}`,
        });
      }
    } catch (error) {
      return rollbackCreatedPaseoWorktree(
        {
          cwd: sourceRepoRoot,
          worktreePath: recreatedWorktreePath,
          teardownCwds: [],
          paseoHome: deps.paseoHome,
          worktreesBaseRoot: deps.worktreesRoot,
        },
        error,
      );
    }
  }

  return { inspect, restore };
}

async function resolveRecoveryBase(repoRoot: string, recordedBase: string | null): Promise<string> {
  if (recordedBase) {
    try {
      await runGitCommand(["rev-parse", "--verify", `${recordedBase}^{commit}`], { cwd: repoRoot });
      return recordedBase;
    } catch {
      // The saved base was removed; use the repository default for continued work.
    }
  }
  const defaultBranch = await resolveRepositoryDefaultBranch(repoRoot);
  if (!defaultBranch) {
    throw new WorktreeRequestError({
      code: "unknown",
      message:
        "The saved base is unavailable and the repository has no default branch to restore from.",
    });
  }
  return defaultBranch;
}

function createRecoveryPlan(
  input:
    | { action: "unarchive"; workspace: PersistedWorkspaceRecord }
    | { action: "restore"; workspace: PersistedWorkspaceRecord; sourceRepoRoot: string },
): RecoveryPlan {
  const state = {
    kind: "recoverable" as const,
    workspaceId: input.workspace.workspaceId,
    workspaceName: resolveWorkspaceDisplayName(input.workspace),
    branch: input.workspace.branch,
  };
  if (input.action === "restore") {
    return {
      kind: input.action,
      state: { ...state, action: input.action },
      workspace: input.workspace,
      sourceRepoRoot: input.sourceRepoRoot,
    };
  }
  return {
    kind: input.action,
    state: {
      ...state,
      action: input.action,
    },
    workspace: input.workspace,
  };
}
