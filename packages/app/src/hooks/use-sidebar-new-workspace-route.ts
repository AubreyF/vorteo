import { useCallback } from "react";
import { router, type Href } from "expo-router";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import {
  resolveSidebarNewWorkspaceRoute,
  type SidebarProjectHostTarget,
} from "@/utils/sidebar-project-row-model";

/**
 * Open New workspace with the clicked project row selected. The workspace the owner is in is read
 * when the plus is pressed, not subscribed to: every project row uses this hook, and a status
 * change in the active workspace must not re-render them all.
 */
export function useSidebarNewWorkspaceRoute(input: {
  project: SidebarProjectEntry;
  displayName: string;
  target: SidebarProjectHostTarget | null;
  onBeforeNavigate?: () => void;
}) {
  const { project, displayName, target, onBeforeNavigate } = input;
  return useCallback(() => {
    if (!target) return;
    onBeforeNavigate?.();
    const selection = getLastWorkspaceSelection();
    const workspace = selection
      ? selectWorkspace(useSessionStore.getState(), selection.serverId, selection.workspaceId)
      : null;
    router.navigate(
      buildNewWorkspaceRoute(
        resolveSidebarNewWorkspaceRoute({
          project,
          displayName,
          target,
          activeWorkspace:
            selection && workspace
              ? {
                  serverId: selection.serverId,
                  workspaceId: selection.workspaceId,
                  projectId: workspace.projectId,
                  projectRootPath: workspace.projectRootPath,
                }
              : null,
        }),
      ) as Href,
    );
  }, [displayName, onBeforeNavigate, project, target]);
}
