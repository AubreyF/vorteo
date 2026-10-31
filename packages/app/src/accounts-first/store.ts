import AsyncStorage from "@/storage/app-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// Installations whose owner skipped or finished the accounts first screen on this device.
// Keyed by installation ID so a second installation still gets its own first screen.
const accountsFirstStateSchema = z.object({
  dismissedInstallations: z.array(z.string()),
});

interface AccountsFirstStoreState {
  dismissedInstallations: string[];
  dismiss: (installationId: string) => void;
}

export const useAccountsFirstStore = create<AccountsFirstStoreState>()(
  persist(
    (set) => ({
      dismissedInstallations: [],
      dismiss: (installationId) =>
        set((state) =>
          state.dismissedInstallations.includes(installationId)
            ? state
            : { dismissedInstallations: [...state.dismissedInstallations, installationId] },
        ),
    }),
    {
      name: "accounts-first-dismissed",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, accountsFirstStateSchema),
      partialize: (state) => ({ dismissedInstallations: state.dismissedInstallations }),
    },
  ),
);

function subscribeHydration(onChange: () => void): () => void {
  return useAccountsFirstStore.persist.onFinishHydration(onChange);
}

/** For useSyncExternalStore: the screen waits for storage so a dismissal never flashes. */
export const accountsFirstHydration = {
  subscribe: subscribeHydration,
  get: () => useAccountsFirstStore.persist.hasHydrated(),
};
