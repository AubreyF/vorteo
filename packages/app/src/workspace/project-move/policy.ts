import type { WorkspaceDescriptor } from "@/stores/session-store";

export function projectMoveBlockedReason(
  workspace: Pick<WorkspaceDescriptor, "protected" | "factoryMembership"> | null | undefined,
): string | null {
  if (workspace?.factoryMembership)
    return "This workspace is managed by Factory and belongs to its installed project. It cannot be moved independently.";
  if (workspace?.protected)
    return "This workspace is protected. Turn off protection in Workspace actions before moving it.";
  return null;
}
