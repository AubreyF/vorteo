import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { SessionState } from "@/stores/session-store";

export interface WorkspaceEnvironmentReference {
  serverId: string;
  workspaceId: string;
}

export function workspaceOwner(
  reference: WorkspaceEnvironmentReference,
  workspace: Pick<WorkspaceDescriptorPayload, "projectMembership"> | undefined,
): WorkspaceEnvironmentReference {
  return workspace?.projectMembership?.environmentOwner ?? reference;
}

export function sameWorkspaceReference(
  a: WorkspaceEnvironmentReference,
  b: WorkspaceEnvironmentReference,
) {
  return a.serverId === b.serverId && a.workspaceId === b.workspaceId;
}

export function workspaceEnvironmentMembers(
  sessions: Record<string, Pick<SessionState, "workspaces"> | undefined>,
  reference: WorkspaceEnvironmentReference,
): WorkspaceEnvironmentReference[] {
  const owner = workspaceOwner(
    reference,
    sessions[reference.serverId]?.workspaces.get(reference.workspaceId),
  );
  if (!sessions[owner.serverId]?.workspaces.has(owner.workspaceId)) return [reference];
  if (
    sessions[owner.serverId]?.workspaces.get(owner.workspaceId)?.projectMembership?.environmentOwner
  )
    return [reference];
  const members = [owner];
  for (const [serverId, session] of Object.entries(sessions)) {
    if (!session) continue;
    for (const workspace of session.workspaces.values()) {
      const binding = workspace.projectMembership?.environmentOwner;
      if (binding && sameWorkspaceReference(owner, binding))
        members.push({ serverId, workspaceId: workspace.id });
    }
  }
  return members;
}
