import { useEffect, useRef } from "react";
import type { AgentContextBreakdown } from "@getpaseo/protocol/agent-context";
import { useShallow } from "zustand/shallow";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";

export type ContextBreakdownView =
  | { kind: "unsupported" }
  | { kind: "loading" }
  | { kind: "error" }
  /** The provider reports totals only. */
  | { kind: "totals" }
  | { kind: "ready"; breakdown: AgentContextBreakdown };

/**
 * The provider's context breakdown, read only while a surface showing it is mounted and active.
 * Reading it can cost the provider a request, so it refreshes when a turn finishes rather than
 * on every usage update.
 */
export function useContextBreakdown(serverId: string, agentId: string): ContextBreakdownView {
  const active = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { supported, status } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        supported: session?.serverInfo?.features?.agentContextBreakdown === true,
        status: agent?.status ?? null,
      };
    }),
  );
  const enabled = supported && connected && active && !!client;
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["agent-context-breakdown", serverId, agentId],
    enabled,
    queryFn: async () => {
      if (!client) throw new Error("The host is disconnected.");
      return client.getAgentContextBreakdown(agentId);
    },
    retry: false,
    // Turn completion triggers the refresh below; focus and remounts reuse the last answer.
    staleTimeMs: 30_000,
  });
  const { refetch } = query;
  const previousStatus = useRef(status);
  useEffect(() => {
    const finishedTurn = previousStatus.current === "running" && status === "idle";
    previousStatus.current = status;
    if (finishedTurn && enabled) void refetch();
  }, [enabled, refetch, status]);

  if (!supported) return { kind: "unsupported" };
  if (query.data) return { kind: "ready", breakdown: query.data };
  if (query.data === null) return { kind: "totals" };
  if (query.isError) return { kind: "error" };
  return { kind: "loading" };
}
