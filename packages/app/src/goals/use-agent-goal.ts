import { useMutation } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useShallow } from "zustand/shallow";
import type { AgentGoalSetInput } from "@getpaseo/protocol/agent-goals";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAgentCommandsQuery, type DraftCommandConfig } from "@/hooks/use-agent-commands-query";

import { goalQueryConfirmed } from "./goal-presentation";

type GoalAction = { kind: "set"; input: AgentGoalSetInput } | { kind: "clear" };

type GoalContext = NonNullable<
  Parameters<import("@getpaseo/client/internal/daemon-client").DaemonClient["setAgentGoal"]>[2]
>;

interface DraftGoalOptions {
  context?: () => Promise<GoalContext>;
  config: DraftCommandConfig | undefined;
  create: ((input: AgentGoalSetInput) => Promise<void>) | undefined;
}

const EMPTY_GOAL = { status: "ready" as const, goal: null, observedAt: new Date(0).toISOString() };

export function useAgentGoal(serverId: string, agentId: string, draft?: DraftGoalOptions) {
  const active = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const snapshot = useSessionStore(
    useShallow((store) => {
      const session = store.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        daemonSupported: session?.serverInfo?.features?.agentGoals === true,
        providerSupported: agent?.capabilities.supportsGoals === true,
        state: agent?.goalState,
        readOnly: agent?.archivedAt != null,
      };
    }),
  );
  const draftCommands = useAgentCommandsQuery({
    serverId: serverId,
    agentId: agentId,
    draftConfig: draft?.config,
    enabled: !!draft?.create && !!draft.config,
  });
  const isDraft = !!draft?.create;
  const providerSupported = isDraft
    ? draftCommands.commands.some((command) => command.name === "goal")
    : snapshot.providerSupported;
  const supported = snapshot.daemonSupported && providerSupported;
  const enabled = supported && active && connected && !!agentId;
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["agent-goal", serverId, agentId, connected],
    enabled: enabled && !isDraft,
    queryFn: async () => {
      if (!client || !agentId) throw new Error("The host is disconnected.");
      return client.getAgentGoal(agentId);
    },
    retry: false,
    staleTimeMs: 0,
  });
  const mutation = useMutation({
    mutationFn: async (action: GoalAction) => {
      if (!enabled || !client || !agentId) throw new Error("The goal is not available.");
      if (draft?.create) {
        if (action.kind !== "set") throw new Error("There is no goal to clear.");
        await draft.create(action.input);
        return EMPTY_GOAL;
      }
      if (action.kind === "clear") return client.clearAgentGoal(agentId);
      const context =
        action.input.objective && !snapshot.state?.goal ? await draft?.context?.() : undefined;
      return client.setAgentGoal(agentId, action.input, context);
    },
    // A timed-out mutation may already have succeeded. Reconcile without replay.
    onSettled: () => {
      if (!isDraft) void query.refetch();
    },
    retry: false,
  });
  const state = isDraft ? EMPTY_GOAL : (snapshot.state ?? query.data);
  const error = goalControlError(mutation.error, query.error, state);
  const confirmed = goalQueryConfirmed(isDraft, query.isFetching, query.error);
  return {
    supported,
    connected,
    readOnly: snapshot.readOnly,
    state,
    error,
    pending: mutation.isPending,
    refreshing: query.isFetching,
    canMutate:
      enabled &&
      !snapshot.readOnly &&
      state?.status === "ready" &&
      !mutation.isPending &&
      confirmed,
    mutate: mutation.mutateAsync,
    refresh: () => {
      mutation.reset();
      if (!isDraft) void query.refetch();
    },
  };
}

export type AgentGoalControl = ReturnType<typeof useAgentGoal>;

function goalControlError(
  mutationError: Error | null,
  queryError: Error | null,
  state: import("@getpaseo/protocol/agent-goals").AgentGoalState | undefined,
): string | null {
  if (mutationError) return mutationError.message;
  if (queryError) return queryError.message;
  return state?.status === "error" ? state.message : null;
}
