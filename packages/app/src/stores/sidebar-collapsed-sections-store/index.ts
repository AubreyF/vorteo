import { recordSidebarChange } from "@/sidebar-state/changes";
import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  type CollapsedProjectsState,
  type PersistedCollapsedProjects,
  mergePersistedCollapsedProjects,
  PersistedCollapsedProjectsSchema,
  serializeCollapsedProjects,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleWorkspaceGroupCollapsed,
} from "./state";

interface SidebarCollapsedSectionsState extends CollapsedProjectsState {
  toggleProjectCollapsed: (projectKey: string) => void;
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void;
  toggleWorkspaceGroupCollapsed: (workspaceGroupKey: string) => void;
  togglePinnedCollapsed: () => void;
}

export const useSidebarCollapsedSectionsStore = create<SidebarCollapsedSectionsState>()(
  persist<SidebarCollapsedSectionsState, [], [], PersistedCollapsedProjects>(
    (set) => ({
      collapsedProjectKeys: new Set(),
      collapsedWorkspaceGroupKeys: new Set(),
      collapsedPinned: false,
      toggleProjectCollapsed: (projectKey) =>
        set((state) => {
          const next = toggleProjectCollapsed(state, projectKey);
          recordSidebarChange({
            collapsedProjects: { [projectKey]: next.collapsedProjectKeys.has(projectKey) },
          });
          return next;
        }),
      setProjectCollapsed: (projectKey, collapsed) =>
        set((state) => {
          recordSidebarChange({ collapsedProjects: { [projectKey]: collapsed } });
          return setProjectCollapsed(state, projectKey, collapsed);
        }),
      toggleWorkspaceGroupCollapsed: (workspaceGroupKey) =>
        set((state) => {
          const next = toggleWorkspaceGroupCollapsed(state, workspaceGroupKey);
          recordSidebarChange({
            collapsedWorkspaceGroups: {
              [workspaceGroupKey]: next.collapsedWorkspaceGroupKeys.has(workspaceGroupKey),
            },
          });
          return next;
        }),
      togglePinnedCollapsed: () =>
        set((state) => {
          const next = togglePinnedCollapsed(state);
          recordSidebarChange({ collapsedPinned: next.collapsedPinned });
          return next;
        }),
    }),
    {
      name: "sidebar-collapsed-sections",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedCollapsedProjectsSchema),
      partialize: (state) => serializeCollapsedProjects(state),
      merge: (persistedState, currentState) =>
        mergePersistedCollapsedProjects(persistedState, currentState),
    },
  ),
);
