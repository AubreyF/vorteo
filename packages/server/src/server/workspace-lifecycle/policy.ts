import {
  isStandingSchedule,
  workspaceArchiveBlockReason,
} from "@getpaseo/protocol/workspace-lifecycle";
import type { ScheduleStore } from "../schedule/store.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

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
  workspace: Pick<PersistedWorkspaceRecord, "workspaceId" | "protected" | "factoryMembership">,
): void {
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
