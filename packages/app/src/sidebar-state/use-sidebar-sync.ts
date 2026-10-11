import { useSessionStore } from "@/stores/session-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { z } from "zod";
import { create } from "zustand";
import { SidebarStatePatchSchema, type SidebarState } from "@getpaseo/protocol/sidebar-state";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHosts, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { subscribeSidebarChanges } from "./changes";
import { SidebarSync, type SidebarSyncStatus } from "./sync";

export const useSidebarSyncStatus = create<{ status: SidebarSyncStatus | "local"; error?: string }>(
  () => ({ status: "local" }),
);

function readLocalSidebar(): SidebarState {
  const order = useSidebarOrderStore.getState();
  const view = useSidebarViewStore.getState();
  const collapsed = useSidebarCollapsedSectionsStore.getState();
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
  };
}

function applyLocalSidebar(state: SidebarState): void {
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
}

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
  const [sync, setSync] = useState<SidebarSync | null>(null);
  useEffect(() => {
    if (!loaded || !serverId) return;
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
    ]).then(() => {
      if (cancelled) return undefined;
      current = new SidebarSync({
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
  }, [loaded, serverId]);
  useFetchQuery({
    queryKey: ["sidebar-state", serverId],
    queryFn: async () => {
      await sync?.refresh();
      return null;
    },
    enabled: sync !== null,
    refetchInterval: 1000,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
}
