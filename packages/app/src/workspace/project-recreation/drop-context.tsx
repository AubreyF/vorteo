import type { PropsWithChildren } from "react";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import type { DraggableListExternalDrop } from "@/components/draggable-list.types";

export function ProjectRecreationProvider({
  children,
}: PropsWithChildren<{ projects: SidebarProjectEntry[] }>) {
  return children;
}
export function ProjectDropTarget({ children }: PropsWithChildren<{ projectKey: string }>) {
  return children;
}
export function useWorkspaceProjectDrop(
  _projectKey?: string,
): DraggableListExternalDrop<SidebarWorkspacePlacement> | undefined {
  return undefined;
}
