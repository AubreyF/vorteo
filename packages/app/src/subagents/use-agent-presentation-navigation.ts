import { useLayoutEffect, useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { resolveAgentPresentation } from "./workspace-root-policy";

interface PresentationTab {
  descriptor: { target: WorkspaceTabTarget };
}

export function useAgentPresentationNavigation(input: {
  serverId: string;
  workspaceId: string;
  tab: PresentationTab | null | undefined;
  isRouteFocused: boolean;
}): boolean {
  const target = input.tab?.descriptor.target;
  const agentId = target?.kind === "agent" ? target.agentId : null;
  const agents = useSessionStore((state) => state.sessions[input.serverId]?.agents);
  const workspaces = useSessionStore((state) => {
    const session = state.sessions[input.serverId];
    return session?.hasHydratedWorkspaces ? session.workspaces : undefined;
  });
  const presentationWorkspaceId = useMemo(() => {
    const agent = agentId ? agents?.get(agentId) : undefined;
    if (!agents || !agent || agent.archivedAt) return null;
    return resolveAgentPresentation({ agent, agents, workspaces }).workspaceId;
  }, [agentId, agents, workspaces]);
  const moving = presentationWorkspaceId !== null && presentationWorkspaceId !== input.workspaceId;

  useLayoutEffect(() => {
    if (!input.isRouteFocused || !moving || !agentId) return;
    navigateToAgent({ serverId: input.serverId, agentId, workspaceId: presentationWorkspaceId });
  }, [input.isRouteFocused, input.serverId, moving, agentId, presentationWorkspaceId]);
  return moving;
}
