import { useFetchQueries } from "@/data/query";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import {
  buildTerminalsQueryKey,
  TERMINALS_QUERY_STALE_TIME,
  type ListTerminalsPayload,
} from "@/screens/workspace/terminals/state";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { resolveAgentPresentation } from "@/subagents/policies";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectoryServerIds } from "@/stores/session-store-hooks";
import { workspaceEqualityFns } from "@/stores/session-store-hooks/selectors";
import { useHostProjects } from "@/projects/host-projects";
import { getHostRuntimeStore, useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  buildSidebarWorkspacePlacementModel,
  collectManagedWorkspacePlacements,
  selectSidebarHierarchySessions,
  sidebarHierarchySessionsEqual,
  type ManagedWorkspacePlacement,
  computeSidebarOrderUpdates,
  createSidebarWorkspaceEntry,
  deriveProjectStatusBucket,
  deriveSidebarLoadingState,
  type ProjectStatusSession,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromHostProjects,
  buildSidebarProjectsFromStructure,
  createSidebarWorkspaceEntry,
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  deriveProjectStatusBucket,
  deriveSidebarLoadingState,
  shouldShowSidebarHostLabels,
  type SidebarLoadingState,
  type SidebarOrderUpdates,
  type SidebarStatusWorkspacePlacement,
  type SidebarWorkspacePlacement,
  type SidebarWorkspacePlacementModel,
  type SidebarProjectEntry,
  type SidebarStateBucket,
  type SidebarWorkspaceEntry,
} from "./sidebar-workspaces-view-model";

/**
 * Aggregate status for a project's workspaces, for the collapsed project row.
 *
 * `SidebarProjectEntry` is structural — it carries workspace identity but no status — and
 * `ProjectBlock` is memoized on that stable reference, so the row can't learn about a
 * child's status without its own subscription. Returns a primitive, so status churn in a
 * project only re-renders the row when the aggregate actually moves.
 *
 * Pass `enabled: false` while the project is expanded: the child rows show their own dots
 * and the selector is pure cost.
 */
export function useSidebarProjectStatusBucket(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  enabled: boolean;
}): SidebarStateBucket | null {
  const { workspaces, enabled } = input;
  const pendingCreateAttempts = useStoreWithEqualityFn(
    useCreateFlowStore,
    (state) => state.pendingByDraftId,
    workspaceEqualityFns.deep,
  );

  const selector = useCallback(
    (state: { sessions: Record<string, ProjectStatusSession | undefined> }) => {
      if (!enabled) return null;
      return deriveProjectStatusBucket({
        workspaces,
        sessions: state.sessions,
        pendingCreateAttempts,
      });
    },
    [enabled, pendingCreateAttempts, workspaces],
  );

  return useStoreWithEqualityFn(useSessionStore, selector, Object.is);
}

const EMPTY_ORDER: string[] = [];
const EMPTY_PROJECTS: SidebarProjectEntry[] = [];
const EMPTY_WORKSPACES: SidebarWorkspacePlacement[] = [];
const EMPTY_PROJECT_NAMES = new Map<string, string>();

export interface SidebarWorkspacesListResult {
  workspacePlacements: SidebarWorkspacePlacement[];
  projects: SidebarProjectEntry[];
  projectNamesByViewKey: Map<string, string>;
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

export function useSidebarWorkspacesList(options?: {
  hostFilters?: readonly string[];
  enabled?: boolean;
}): SidebarWorkspacesListResult {
  const runtime = getHostRuntimeStore();
  const allHosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);

  const storeHostFilters = useSidebarViewStore((state) => state.hostFilters);
  const hostFilters = options?.hostFilters ?? storeHostFilters;
  const reconcileHostFilters = useSidebarViewStore((state) => state.reconcileHostFilters);
  const isActive = options?.enabled !== false;

  const serverIds = useMemo(() => {
    if (hostFilters.length === 0) {
      return allServerIds;
    }
    const selected = new Set(hostFilters);
    const matched = allServerIds.filter((id) => selected.has(id));
    // Registry has settled but none of the pinned hosts still exist — fall back to every
    // host rather than leaving the sidebar empty.
    if (hostRegistryLoaded && matched.length === 0) {
      return allServerIds;
    }
    return matched;
  }, [allServerIds, hostFilters, hostRegistryLoaded]);
  useEffect(() => {
    if (!isActive) return;
    const releases = serverIds.map((serverId) => runtime.acquireDirectoryDemand(serverId));
    return () => releases.forEach((release) => release());
  }, [isActive, runtime, serverIds]);

  useEffect(() => {
    if (!hostRegistryLoaded) {
      return;
    }
    reconcileHostFilters(allServerIds);
  }, [allServerIds, hostRegistryLoaded, reconcileHostFilters]);

  const persistedProjectOrder = useSidebarOrderStore((state) => state.projectOrder ?? EMPTY_ORDER);

  const directoryServerIds = useWorkspaceDirectoryServerIds(serverIds);

  const hostProjects = useHostProjects(directoryServerIds);

  const hierarchySessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSidebarHierarchySessions(state.sessions, directoryServerIds),
    sidebarHierarchySessionsEqual,
  );
  const previousManaged = useRef<ManagedWorkspacePlacement[]>([]);
  const managedWorkspaces = useMemo(() => {
    const next = collectManagedWorkspacePlacements({
      projects: hostProjects,
      sessions: hierarchySessions,
    });
    const previous = previousManaged.current;
    const unchanged =
      next.length === previous.length &&
      next.every((placement, index) => {
        const old = previous[index];
        return (
          old !== undefined &&
          placement.workspaceKey === old.workspaceKey &&
          placement.parentWorkspaceKey === old.parentWorkspaceKey &&
          placement.workspace.workspaceDirectory === old.workspace.workspaceDirectory &&
          placement.workspace.scripts.length === old.workspace.scripts.length &&
          placement.workspace.archivingAt === old.workspace.archivingAt
        );
      });
    if (unchanged) return previous;
    previousManaged.current = next;
    return next;
  }, [hostProjects, hierarchySessions]);
  const terminalQueries = useFetchQueries<ListTerminalsPayload>(
    managedWorkspaces.map((placement) => {
      const session = hierarchySessions.find((entry) => entry.serverId === placement.serverId);
      const client = session?.client;
      const enabled =
        isActive &&
        session?.isConnected === true &&
        session.supportsWorkspaceTerminals &&
        !!placement.workspace.workspaceDirectory;
      return {
        dataShape: "value",
        staleTimeMs: TERMINALS_QUERY_STALE_TIME,
        queryKey: [
          ...buildTerminalsQueryKey(
            placement.serverId,
            placement.workspace.workspaceDirectory,
            placement.workspace.id,
          ),
          "sidebar-hierarchy",
        ],
        enabled,
        retry: false,
        meta: workspaceTerminalsPushRoute({
          enabled,
          serverId: placement.serverId,
          cwd: placement.workspace.workspaceDirectory,
          workspaceId: placement.workspace.id,
        }),
        queryFn: async () => {
          if (!client) throw new Error("The host is disconnected.");
          return client.listTerminals(placement.workspace.workspaceDirectory, undefined, {
            workspaceId: placement.workspace.id,
          });
        },
      };
    }),
  );
  const layouts = useWorkspaceLayoutStore((state) => state.layoutByWorkspace);
  const pendingCreates = useCreateFlowStore((state) => state.pendingByDraftId);
  const previousPreserved = useRef(new Set<string>());
  const preservedWorkspaceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const placement of managedWorkspaces) {
      const layout = layouts[placement.workspaceKey];
      const session = hierarchySessions.find((entry) => entry.serverId === placement.serverId);
      if (!layout || !session) continue;
      const hasIndependentSurface = collectAllTabs(layout.root).some((tab) => {
        if (tab.target.kind === "new_tab") return false;
        if (tab.target.kind !== "agent") return true;
        const agent = session.agents.get(tab.target.agentId);
        return (
          !agent ||
          resolveAgentPresentation({
            agent,
            agents: session.agents,
            workspaces: session.workspaces,
          }).workspaceId === placement.workspace.id
        );
      });
      if (hasIndependentSurface) keys.add(placement.workspaceKey);
    }
    for (const pending of Object.values(pendingCreates)) {
      if (pending.workspaceId && pending.lifecycle !== "abandoned")
        keys.add(`${pending.serverId}:${pending.workspaceId}`);
    }
    const previous = previousPreserved.current;
    if (keys.size === previous.size && [...keys].every((key) => previous.has(key))) return previous;
    previousPreserved.current = keys;
    return keys;
  }, [managedWorkspaces, layouts, hierarchySessions, pendingCreates]);
  const nextTerminalPresence = new Map<string, boolean>();
  for (const [index, placement] of managedWorkspaces.entries()) {
    const query = terminalQueries[index];
    const session = hierarchySessions.find((entry) => entry.serverId === placement.serverId);
    if (
      session?.isConnected &&
      session.supportsWorkspaceTerminals &&
      query?.isSuccess &&
      !query.isFetching &&
      query.data
    ) {
      nextTerminalPresence.set(placement.workspaceKey, query.data.terminals.length > 0);
    }
  }
  const previousTerminalPresence = useRef(new Map<string, boolean>());
  const previous = previousTerminalPresence.current;
  const terminalPresenceUnchanged =
    nextTerminalPresence.size === previous.size &&
    [...nextTerminalPresence].every(([key, value]) => previous.get(key) === value);
  const terminalPresence = terminalPresenceUnchanged ? previous : nextTerminalPresence;
  previousTerminalPresence.current = terminalPresence;
  const sidebarModel = useMemo(
    () =>
      buildSidebarWorkspacePlacementModel({
        projects: hostProjects,
        managedWorkspaces,
        terminalPresence,
        preservedWorkspaceKeys,
      }),
    [hostProjects, managedWorkspaces, terminalPresence, preservedWorkspaceKeys],
  );

  const projects = sidebarModel.projects.length > 0 ? sidebarModel.projects : EMPTY_PROJECTS;
  const workspacePlacements =
    sidebarModel.workspaces.length > 0 ? sidebarModel.workspaces : EMPTY_WORKSPACES;
  const projectNamesByViewKey =
    sidebarModel.projectNamesByViewKey.size > 0
      ? sidebarModel.projectNamesByViewKey
      : EMPTY_PROJECT_NAMES;

  useEffect(() => {
    const orderStore = useSidebarOrderStore.getState();
    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder,
      getWorkspaceOrder: (projectViewKey) =>
        orderStore.workspaceOrderByProject[projectViewKey] ?? EMPTY_ORDER,
    });

    if (updates.projectOrder) {
      orderStore.setProjectOrder(updates.projectOrder);
    }
    for (const { projectViewKey, order } of updates.workspaceOrders) {
      orderStore.setWorkspaceOrder(projectViewKey, order);
    }
  }, [persistedProjectOrder, projects]);

  const refreshAll = useCallback(() => {
    if (!isActive) return;
    for (const serverId of serverIds) {
      void runtime.refreshDirectories(serverId).catch((error) => {
        console.error("[WorkspaceFetch][sidebar-refresh] failed", {
          serverId,
          error,
        });
      });
    }
  }, [isActive, runtime, serverIds]);

  const loadingState = deriveSidebarLoadingState({
    isActive,
    serverIds,
    hydratedServerIds: directoryServerIds,
    hasProjects: projects.length > 0,
  });

  return {
    workspacePlacements,
    projects,
    projectNamesByViewKey,
    ...loadingState,
    refreshAll,
  };
}
