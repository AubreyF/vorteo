import {
  isStandingSchedule,
  workspaceArchiveBlockReason,
} from "@getpaseo/protocol/workspace-lifecycle";
import type { ScheduleStore } from "../schedule/store.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";

export class WorkspaceProtectedError extends Error {
  constructor(
    readonly workspaceId: string,
    reason = "Unprotect to archive",
  ) {
    super(
      `Archive blocked: this workspace is protected from archival. ${reason}. The workspace and its threads were not archived.`,
    );
    this.name = "WorkspaceProtectedError";
  }
}

export class WorkspaceFactoryManagedError extends Error {
  constructor(readonly workspaceId: string) {
    super("This workspace belongs to Factory. Use reconciled Factory cleanup or owner disable.");
    this.name = "WorkspaceFactoryManagedError";
  }
}

/** Raised when a request would change something the daemon manages for Vorteo System. */
export class SystemManagedError extends Error {
  constructor(subject: string) {
    super(
      `${subject} is managed by Vorteo System, so it cannot be archived, removed, moved, renamed or unprotected.`,
    );
    this.name = "SystemManagedError";
  }
}

/**
 * Keeps daemon-owned system project fields fixed across ordinary writes.
 * `next` is null for removal. Kind may change, so the project can become a git
 * checkout once its source is set up. The key never follows the git remote,
 * so the system project never merges into another project's group.
 */
export function pinSystemProjectFields<T extends PersistedProjectRecord | null>(
  existing: PersistedProjectRecord | null,
  next: T,
): T {
  if (!existing?.systemProject) {
    if (next?.systemProject)
      throw new Error("The Vorteo System marker can only be written by daemon startup.");
    return next;
  }
  if (!next || next.archivedAt || next.customName !== existing.customName)
    throw new SystemManagedError("The Vorteo System project");
  return { ...next, systemProject: existing.systemProject, projectKey: existing.projectKey };
}

/** Keeps a system-managed workspace's identity, placement and protection fixed. */
export function pinSystemWorkspaceFields(
  existing: PersistedWorkspaceRecord | null,
  next: PersistedWorkspaceRecord,
): PersistedWorkspaceRecord {
  if (!existing?.systemMembership) {
    if (next.systemMembership)
      throw new Error("System workspace roles can only be written by daemon startup.");
    return next;
  }
  const moved =
    next.projectId !== existing.projectId ||
    next.cwd !== existing.cwd ||
    next.kind !== existing.kind ||
    next.title !== existing.title ||
    next.archivedAt !== existing.archivedAt ||
    next.standing === false ||
    next.protected === false;
  if (moved) throw new SystemManagedError("This system workspace");
  return {
    ...next,
    systemMembership: existing.systemMembership,
    standing: true,
    protected: true,
  };
}

/** Descriptor fields that let clients group and lock Vorteo System items. */
export function systemFieldsForDescriptor(
  workspace: Pick<PersistedWorkspaceRecord, "systemMembership">,
  project: Pick<PersistedProjectRecord, "systemProject"> | null | undefined,
): {
  projectSystem?: NonNullable<PersistedProjectRecord["systemProject"]>;
  systemMembership?: NonNullable<PersistedWorkspaceRecord["systemMembership"]>;
} {
  return {
    ...(project?.systemProject ? { projectSystem: project.systemProject } : {}),
    ...(workspace.systemMembership ? { systemMembership: workspace.systemMembership } : {}),
  };
}

export function assertWorkspaceNotSystemManaged(
  workspace: Pick<PersistedWorkspaceRecord, "systemMembership">,
): void {
  if (workspace.systemMembership) throw new SystemManagedError("This system workspace");
}

export function assertWorkspaceNotFactoryManaged(
  workspace: Pick<PersistedWorkspaceRecord, "workspaceId" | "factoryMembership">,
): void {
  if (workspace.factoryMembership) throw new WorkspaceFactoryManagedError(workspace.workspaceId);
}

export function factoryMembershipForDescriptor({
  workspace,
  serverId,
}: {
  workspace: Pick<PersistedWorkspaceRecord, "projectId" | "factoryMembership">;
  serverId: string | undefined;
}): Pick<PersistedWorkspaceRecord, "factoryMembership"> {
  const membership = workspace.factoryMembership;
  if (
    !membership ||
    membership.serverId !== serverId ||
    membership.projectId !== workspace.projectId
  ) {
    return {};
  }
  return { factoryMembership: membership };
}

export function assertWorkspaceUnprotected(
  workspace: Pick<
    PersistedWorkspaceRecord,
    "workspaceId" | "protected" | "factoryMembership" | "systemMembership"
  >,
): void {
  assertWorkspaceNotSystemManaged(workspace);
  // Even an invalid retained binding blocks destruction until native reconciliation.
  assertWorkspaceNotFactoryManaged(workspace);
  if (workspace.protected) throw new WorkspaceProtectedError(workspace.workspaceId);
}

export function setWorkspaceLifecycle(
  workspace: PersistedWorkspaceRecord,
  change: { standing?: boolean; protected?: boolean },
): PersistedWorkspaceRecord {
  if (workspace.archivedAt)
    throw new Error("Restore this workspace before changing its lifecycle.");
  if (change.standing === undefined && change.protected === undefined) {
    throw new Error("Choose Standing or Protected to update.");
  }
  if (change.protected === false) assertWorkspaceNotFactoryManaged(workspace);
  // Leaving Standing never silently removes an independently useful protection.
  const protectOnStanding = change.standing === true && !workspace.standing;
  return {
    ...workspace,
    standing: change.standing ?? workspace.standing ?? false,
    protected: change.protected ?? (protectOnStanding || workspace.protected === true),
    updatedAt: new Date().toISOString(),
  };
}

export async function assertWorkspaceArchiveAllowed(
  dependencies: {
    workspaces: Pick<WorkspaceRegistry, "get">;
    schedules: Pick<ScheduleStore, "list">;
    agents: Pick<AgentStorage, "listByWorkspace">;
    now?: () => number;
  },
  workspaceId: string,
): Promise<void> {
  const workspace = await dependencies.workspaces.get(workspaceId);
  if (!workspace) return;
  const schedules = await dependencies.schedules.list();
  const agents = await dependencies.agents.listByWorkspace(workspaceId);
  const agentIds = new Set(agents.filter((agent) => !agent.archivedAt).map((agent) => agent.id));
  const now = dependencies.now?.() ?? Date.now();
  const scheduled = schedules.some(
    (schedule) =>
      isStandingSchedule(schedule, now) &&
      schedule.target.type === "agent" &&
      agentIds.has(schedule.target.agentId),
  );
  const reason = workspaceArchiveBlockReason({ protected: workspace.protected, scheduled });
  if (reason) throw new WorkspaceProtectedError(workspaceId, reason);
}
