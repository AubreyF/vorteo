import { useEffect, useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { groupVisibleAgentsByEnvironment } from "./visible-agent-ids";

/** Each daemon owns its agent details and timeline, including after a page reload. */
export function useVisibleAgentSync(input: {
  serverId: string;
  persistenceKey: string | null;
  agentIds: string[];
  tabs: WorkspaceTab[];
}) {
  const nextGroups = groupVisibleAgentsByEnvironment(input.serverId, input.agentIds, input.tabs);
  const stableGroups = useRef(nextGroups);
  if (JSON.stringify(stableGroups.current) !== JSON.stringify(nextGroups)) {
    stableGroups.current = nextGroups;
  }
  const groups = stableGroups.current;
  const owners = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.sessions).map(([id, session]) => [id, session.viewedTimelineSync]),
      ),
    ),
  );
  useEffect(() => {
    for (const [serverId, agentIds] of Object.entries(groups)) {
      for (const agentId of agentIds) {
        void getHostRuntimeStore()
          .prepareAgentTimeline(serverId, agentId)
          .catch(() => undefined);
      }
    }
  }, [groups]);
  useLayoutEffect(() => {
    const key = input.persistenceKey;
    if (!key) return;
    for (const [serverId, owner] of Object.entries(owners)) {
      owner?.replaceVisibleAgentIds(key, groups[serverId] ?? []);
    }
    return () => {
      for (const owner of Object.values(owners)) owner?.replaceVisibleAgentIds(key, []);
    };
  }, [groups, owners, input.persistenceKey]);
}
