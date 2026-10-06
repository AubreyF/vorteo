import { useEffect } from "react";
import { useFetchQueries } from "@/data/query";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

import { SidebarCountBadge } from "@/components/sidebar/sidebar-count-badge";
import { messageQueueKey, readSharedQueue, watchSharedQueue } from "./runtime";

const ignoreSubscriptionError = () => {};

export function WorkspaceQueueCount({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const connected = useHostRuntimeIsConnected(serverId);
  const agentIds = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      if (!session?.serverInfo?.features?.durableMessageQueue) return [];
      return [...session.agents.values()]
        .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)
        .map((agent) => agent.id)
        .sort();
    }),
  );
  // Observe every task in the row, including tasks that have never been opened
  // on this device. Runtime subscriptions are shared with open task cards.
  useEffect(() => {
    if (!connected) return;
    const release = agentIds.map((id) => watchSharedQueue(serverId, id, ignoreSubscriptionError));
    return () => release.forEach((stop) => stop());
  }, [agentIds, connected, serverId]);
  const queues = useFetchQueries(
    agentIds.map((agentId) => ({
      dataShape: "value",
      queryKey: messageQueueKey(serverId, agentId),
      queryFn: () => readSharedQueue(serverId, agentId),
      enabled: connected,
      staleTimeMs: 30_000,
      retry: false,
    })),
  );
  const count = queues.reduce((total, queue) => total + (queue.data?.items.length ?? 0), 0);
  if (!count) return null;
  return (
    <SidebarCountBadge
      label={`Q${count}`}
      accessibilityLabel={`${count} queued messages`}
      testID={`workspace-queue-count-${serverId}-${workspaceId}`}
    />
  );
}
