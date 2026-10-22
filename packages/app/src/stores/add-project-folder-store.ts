import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// The Projects folder browser reopens where the owner last added, created or cloned,
// per host, across reloads. Paths are relative to the Projects folder.
const lastFolderStateSchema = z.object({
  lastFolderByHost: z.record(z.string(), z.string()),
});

interface AddProjectFolderStoreState {
  lastFolderByHost: Record<string, string>;
  rememberFolder: (serverId: string, path: string) => void;
}

export const useAddProjectFolderStore = create<AddProjectFolderStoreState>()(
  persist(
    (set) => ({
      lastFolderByHost: {},
      rememberFolder: (serverId, path) =>
        set((state) => ({ lastFolderByHost: { ...state.lastFolderByHost, [serverId]: path } })),
    }),
    {
      name: "add-project-last-folder",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, lastFolderStateSchema),
      partialize: (state) => ({ lastFolderByHost: state.lastFolderByHost }),
    },
  ),
);
