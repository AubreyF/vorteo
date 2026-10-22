import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { SidebarFolderSchema } from "@getpaseo/protocol/sidebar-state";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export const SidebarFolderStateSchema = z.object({
  sidebarFolders: z.record(z.string(), SidebarFolderSchema),
  itemFolder: z.record(z.string(), z.string()),
  childOrder: z.record(z.string(), z.array(z.string())),
  collapsedFolders: z.record(z.string(), z.boolean()),
});
export type SidebarFolderState = z.infer<typeof SidebarFolderStateSchema>;

export const EMPTY_SIDEBAR_FOLDER_STATE: SidebarFolderState = {
  sidebarFolders: {},
  itemFolder: {},
  childOrder: {},
  collapsedFolders: {},
};

/** Changes go through `commitSidebarPatch`, which keeps the shared rules in one place. */
export const useSidebarFolderStore = create<SidebarFolderState>()(
  persist(() => EMPTY_SIDEBAR_FOLDER_STATE, {
    name: "sidebar-folders",
    storage: createValidatedPersistStorage(AsyncStorage, SidebarFolderStateSchema),
    version: 1,
  }),
);
