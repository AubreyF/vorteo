import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { StoredSidebarFocusSchema, type StoredSidebarFocus } from "./model";

const PersistedSidebarFocusSchema = z.object({ focus: StoredSidebarFocusSchema.nullable() });

interface SidebarFocusStoreState {
  focus: StoredSidebarFocus | null;
  setFocus: (focus: StoredSidebarFocus | null) => void;
}

/**
 * Which sidebar item this device is focused on. Local like sidebar width: it persists on the
 * device and is never written to the shared sidebar state.
 */
export const useSidebarFocusStore = create<SidebarFocusStoreState>()(
  persist(
    (set) => ({
      focus: null,
      setFocus: (focus) => set({ focus }),
    }),
    {
      name: "sidebar-focus",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, PersistedSidebarFocusSchema),
      partialize: (state) => ({ focus: state.focus }),
    },
  ),
);
