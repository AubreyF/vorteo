import {
  applySidebarStatePatch,
  type SidebarState,
  type SidebarStatePatch,
} from "@getpaseo/protocol/sidebar-state";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarFolderStore } from "@/sidebar-folders/store";
import { recordSidebarChange } from "./changes";

export function readLocalSidebar(): SidebarState {
  const order = useSidebarOrderStore.getState();
  const view = useSidebarViewStore.getState();
  const collapsed = useSidebarCollapsedSectionsStore.getState();
  const folders = useSidebarFolderStore.getState();
  return {
    projectOrder: order.projectOrder,
    pinnedWorkspaceOrder: order.pinnedWorkspaceOrder,
    workspaceOrderByProject: order.workspaceOrderByProject,
    collapsedProjects: Object.fromEntries(
      [...collapsed.collapsedProjectKeys].map((key) => [key, true]),
    ),
    collapsedWorkspaceGroups: Object.fromEntries(
      [...collapsed.collapsedWorkspaceGroupKeys].map((key) => [key, true]),
    ),
    collapsedPinned: collapsed.collapsedPinned,
    groupMode: view.groupMode,
    hostFilters: view.hostFilters,
    projectFilters: view.projectFilters,
    labelFilters: view.labelFilter.labels,
    sidebarFolders: folders.sidebarFolders,
    itemFolder: folders.itemFolder,
    childOrder: folders.childOrder,
    collapsedFolders: folders.collapsedFolders,
  };
}

/** Hosts without folder support, and states written before folders existed, omit these fields. */
function withFolderDefaults(state: SidebarState): SidebarState {
  return {
    ...state,
    sidebarFolders: state.sidebarFolders ?? {},
    itemFolder: state.itemFolder ?? {},
    childOrder: state.childOrder ?? {},
    collapsedFolders: state.collapsedFolders ?? {},
  };
}

export function applyLocalSidebar(remote: SidebarState): void {
  const state = withFolderDefaults(remote);
  // Avoid waking the retained sidebar on every unchanged poll.
  if (JSON.stringify(readLocalSidebar()) === JSON.stringify(state)) return;
  useSidebarOrderStore.setState({
    projectOrder: state.projectOrder,
    pinnedWorkspaceOrder: state.pinnedWorkspaceOrder,
    workspaceOrderByProject: state.workspaceOrderByProject,
  });
  useSidebarViewStore.setState({
    groupMode: state.groupMode,
    hostFilters: state.hostFilters,
    projectFilters: state.projectFilters,
    labelFilter: { labels: state.labelFilters },
  });
  useSidebarCollapsedSectionsStore.setState({
    collapsedProjectKeys: new Set(
      Object.keys(state.collapsedProjects).filter((key) => state.collapsedProjects[key]),
    ),
    collapsedWorkspaceGroupKeys: new Set(
      Object.keys(state.collapsedWorkspaceGroups).filter(
        (key) => state.collapsedWorkspaceGroups[key],
      ),
    ),
    collapsedPinned: state.collapsedPinned,
  });
  useSidebarFolderStore.setState({
    sidebarFolders: state.sidebarFolders,
    itemFolder: state.itemFolder,
    childOrder: state.childOrder,
    collapsedFolders: state.collapsedFolders,
  });
}

/** Applies a user edit with the same rules the Host uses, then queues it for synchronization. */
export function commitSidebarPatch(patch: SidebarStatePatch): void {
  applyLocalSidebar(applySidebarStatePatch(readLocalSidebar(), patch));
  recordSidebarChange(patch);
}
