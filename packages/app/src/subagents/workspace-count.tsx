import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { getAgentPresentationIndex } from "./workspace-root-policy";
import { CountBadge } from "@/components/ui/count-badge";
import { selectSubagentsForParent, selectProviderSubagentsForParent } from "./select";
import { refreshProviderSubagents, useProviderSubagentStore } from "./provider-store";

export function WorkspaceSubagentCount({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const pending = usePendingArchiveAgentIds(serverId);
  const parents = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      if (!session) return [];
      const presentations = getAgentPresentationIndex(
        session.agents,
        session.hasHydratedWorkspaces ? session.workspaces : undefined,
      );
      return [...session.agents.values()]
        .filter(
          (agent) =>
            !agent.archivedAt &&
            !pending.has(agent.id) &&
            presentations.get(agent.id)?.workspaceId === workspaceId,
        )
        .map((agent) => agent.id)
        .sort();
    }),
  );
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const nestingSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  // Match the cards: direct children, including finished agents until archived.
  const managedCount = useSessionStore((state) =>
    parents.reduce(
      (sum, parentAgentId) =>
        sum + selectSubagentsForParent(state, { serverId, parentAgentId }, pending).length,
      0,
    ),
  );
  const providerCount = useProviderSubagentStore((state) =>
    parents.reduce(
      (sum, parentAgentId) =>
        sum +
        selectProviderSubagentsForParent(
          state,
          { serverId, parentAgentId },
          supported,
          nestingSupported,
        ).length,
      0,
    ),
  );
  useEffect(() => {
    if (!client || !supported) return;
    for (const parent of parents)
      void refreshProviderSubagents(client, serverId, parent).catch(() => undefined);
  }, [client, supported, serverId, parents]);
  const count = managedCount + providerCount;
  return count ? (
    <CountBadge
      label={`A${count}`}
      accessibilityLabel={`${count} subagents`}
      testID={`workspace-subagent-count-${serverId}-${workspaceId}`}
    />
  ) : null;
}
