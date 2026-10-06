import { create } from "zustand";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";

interface ProjectMoveRequest {
  serverId: string;
  workspaceId: string;
  projectKey?: string;
}

export const useProjectMoveRequest = create<{
  request: ProjectMoveRequest | null;
  open: (request: ProjectMoveRequest) => void;
  close: () => void;
}>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function moveWorkspaceToProject(workspace: SidebarWorkspacePlacement, projectKey: string) {
  useProjectMoveRequest.getState().open({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    projectKey,
  });
}
