import { isDemoSession } from "@/demo/mode";
import { isIsolatedDemoPreview } from "@/demo/preview";
import { useSessionStore } from "@/stores/session-store";
import AsyncStorage from "@/storage/app-storage";
import { useEffect, useState } from "react";
import { z } from "zod";
import { create } from "zustand";
import { SidebarStatePatchSchema } from "@getpaseo/protocol/sidebar-state";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHosts, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarFolderStore } from "@/sidebar-folders/store";
import { applyLocalSidebar, readLocalSidebar } from "./local";
import { subscribeSidebarChanges } from "./changes";
import { SidebarSync, type SidebarSyncStatus } from "./sync";

export const useSidebarSyncStatus = create<{
  status: SidebarSyncStatus | "local";
  error?: string;
  /** Whether the sidebar authority stores folders. Folder controls appear only when it does. */
  foldersSupported: boolean;
}>(() => ({ status: "local", foldersSupported: false }));

interface PersistHydration {
  hasHydrated(): boolean;
  onFinishHydration(listener: () => void): () => void;
}
function waitForHydration(persist: PersistHydration): Promise<void> {
  if (persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const release = persist.onFinishHydration(() => {
      release();
      resolve();
    });
  });
}

export function useSidebarSync(): void {
  const demo = isDemoSession() || isIsolatedDemoPreview;
  const hosts = useHosts();
  const loaded = useHostRegistryLoaded();
  const installation = readExecutionInstallation();
  // Never switch authorities because a daemon temporarily disconnects.
  const hostAuthority = installation?.environments.find(
    (environment) => environment.kind === "host",
  )?.serverId;
  const standaloneAuthority = useSessionStore((state) => {
    const ids = hosts.map((host) => host.serverId).sort();
    const capable = ids.find(
      (id) => state.sessions[id]?.serverInfo?.features?.sidebarState === true,
    );
    if (capable) return capable;
    // Old standalone daemons get an explicit update message after discovery finishes.
    const discovered = ids.every((id) => state.sessions[id]?.serverInfo != null);
    return discovered ? ids[0] : undefined;
  });
  const serverId = hostAuthority ?? standaloneAuthority;
  const foldersSupported = useSessionStore(
    (state) =>
      !demo &&
      serverId !== undefined &&
      state.sessions[serverId]?.serverInfo?.features?.sidebarFolders === true,
  );
  useEffect(() => {
    useSidebarSyncStatus.setState({ foldersSupported });
  }, [foldersSupported]);
  const [sync, setSync] = useState<SidebarSync | null>(null);
  useEffect(() => {
    if (demo || !loaded || !serverId) return;
    let cancelled = false;
    let current: SidebarSync | null = null;
    let unsubscribe = () => {};
    useSidebarSyncStatus.setState({ status: "loading" });
    const storageKey = `sidebar-sync-outbox:${serverId}`;
    function client() {
      const snapshot = getHostRuntimeStore().getSnapshot(serverId!);
      if (!snapshot?.client || snapshot.connectionStatus !== "online")
        throw new Error("Sidebar host is disconnected");
      return snapshot.client;
    }
    void Promise.all([
      waitForHydration(useSidebarOrderStore.persist),
      waitForHydration(useSidebarViewStore.persist),
      waitForHydration(useSidebarCollapsedSectionsStore.persist),
      waitForHydration(useSidebarFolderStore.persist),
    ]).then(() => {
      if (cancelled) return undefined;
      current = new SidebarSync({
        pendingKey: storageKey,
        read: async () => (await client().readSidebarState()).snapshot,
        change: async (change) => (await client().changeSidebarState(change)).snapshot,
        readLocal: readLocalSidebar,
        applyLocal: applyLocalSidebar,
        loadPending: async () => {
          const value = await AsyncStorage.getItem(storageKey);
          return value === null ? [] : z.array(SidebarStatePatchSchema).parse(JSON.parse(value));
        },
        savePending: async (patches) => {
          await AsyncStorage.setItem(storageKey, JSON.stringify(patches));
        },
        status: (status, error) => {
          if (!cancelled) useSidebarSyncStatus.setState({ status, error });
        },
      });
      const active = current;
      unsubscribe = subscribeSidebarChanges((patch) => active.record(patch));
      setSync(active);
      return undefined;
    });
    return () => {
      cancelled = true;
      unsubscribe();
      current?.stop();
      setSync(null);
    };
  }, [demo, loaded, serverId]);
  useFetchQuery({
    queryKey: ["sidebar-state", serverId],
    queryFn: async () => {
      await sync?.refresh();
      return null;
    },
    enabled: !demo && sync !== null,
    refetchInterval: 1000,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
}
