import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const PersistedNewWorkspaceProjectSchema = z.object({
  lastManualViewKey: z.string().min(1).nullable(),
});
type PersistedNewWorkspaceProject = z.infer<typeof PersistedNewWorkspaceProjectSchema>;

interface NewWorkspaceProjectState extends PersistedNewWorkspaceProject {
  rememberManualProject: (viewKey: string) => void;
}

/**
 * The project the owner last picked by hand on New workspace. When neither the route nor the
 * workspace they came from names a usable project, this is the next best guess; after that the
 * picker asks instead of choosing the first project in the list.
 */
export const useNewWorkspaceProjectStore = create<NewWorkspaceProjectState>()(
  persist<NewWorkspaceProjectState, [], [], PersistedNewWorkspaceProject>(
    (set) => ({
      lastManualViewKey: null,
      rememberManualProject: (viewKey) => set({ lastManualViewKey: viewKey }),
    }),
    {
      name: "new-workspace-project",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedNewWorkspaceProjectSchema),
      partialize: (state) => ({ lastManualViewKey: state.lastManualViewKey }),
    },
  ),
);
