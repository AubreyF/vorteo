import type { WorkspaceDescriptor } from "@/stores/session-store";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";
import { SYSTEM_MANAGED_EXPLANATION } from "@/workspace/lifecycle/system-workspace";

export function projectMoveBlockedReason(
  workspace: Pick<WorkspaceDescriptor, "protected" | "factoryMembership"> | null | undefined,
  systemManaged = false,
): string | null {
  if (systemManaged) return `${SYSTEM_MANAGED_EXPLANATION}. It stays in the Vorteo System project.`;
  if (workspace?.factoryMembership)
    return "This workspace is managed by Factory and belongs to its installed project. It cannot be moved independently.";
  if (workspace?.protected)
    return "This workspace is protected. Turn off protection in Workspace actions before moving it.";
  return null;
}

/**
 * The local project to move along with the group, if any. A group should use one local project per
 * host; otherwise New workspace cannot tell which folder the group means there. Move it only when
 * the target group has exactly one placement on this host, and only for plain folders: repository
 * checkouts and worktrees stay with their repository's project.
 */
export function placementForProjectMove(input: {
  workspace: Pick<WorkspaceDescriptor, "projectId" | "workspaceKind"> | null | undefined;
  target: HostProjectListItem;
  serverId: string;
}): string | undefined {
  const { workspace } = input;
  if (!workspace || workspace.workspaceKind !== "directory") return undefined;
  const projectId = getHostProjectId(input.target, input.serverId);
  return projectId && projectId !== workspace.projectId ? projectId : undefined;
}
