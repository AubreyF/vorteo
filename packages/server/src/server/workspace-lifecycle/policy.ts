import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

export class WorkspaceProtectedError extends Error {
  constructor(readonly workspaceId: string) {
    super("This workspace is protected. Remove protection before archiving it or its threads.");
    this.name = "WorkspaceProtectedError";
  }
}

export function assertWorkspaceUnprotected(
  workspace: Pick<PersistedWorkspaceRecord, "workspaceId" | "protected">,
): void {
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
