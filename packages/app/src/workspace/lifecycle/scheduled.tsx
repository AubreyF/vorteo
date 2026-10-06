import { createContext, useContext, useMemo, type PropsWithChildren } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFetchQueries } from "@/data/query";
import {
  useHosts,
  useHostRuntimeConnectionStatuses,
  getHostRuntimeStore,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { scheduledWorkspaceKeys } from "./scheduled-workspaces";

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const ScheduledWorkspaces = createContext(EMPTY_KEYS);

export function ScheduledWorkspaceProvider({ children }: PropsWithChildren) {
  const hosts = useHosts();
  const active = useRetainedPanelActive();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const agentMaps = useSessionStore(
    useShallow((state) => serverIds.map((id) => state.sessions[id]?.agents)),
  );
  // One query per host preserves its last known association while disconnected.
  // Polling is collection-owned and stops when the sidebar is retained but hidden.
  const queries = useFetchQueries(
    serverIds.map((serverId) => ({
      queryKey: ["schedules", "workspace-indicators", serverId],
      enabled: active && statuses.get(serverId) === "online",
      staleTimeMs: 5_000,
      refetchInterval: active ? 15_000 : false,
      dataShape: "list" as const,
      queryFn: async () => {
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error("Host disconnected");
        const payload = await client.scheduleList();
        if (payload.error) throw new Error(payload.error);
        return payload.schedules;
      },
    })),
  );
  const keys = scheduledWorkspaceKeys(
    serverIds.map((serverId, index) => ({
      serverId,
      schedules: queries[index].data ?? [],
      agents: agentMaps[index] ?? new Map(),
    })),
    Date.now(),
  );
  return <ScheduledWorkspaces.Provider value={keys}>{children}</ScheduledWorkspaces.Provider>;
}

export function useWorkspaceScheduled(serverId: string, workspaceId: string): boolean {
  return useContext(ScheduledWorkspaces).has(`${serverId}:${workspaceId}`);
}
