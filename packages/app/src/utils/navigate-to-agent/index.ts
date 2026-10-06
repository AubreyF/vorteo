import { router, type Href } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { resolveAgentPresentation } from "@/subagents/policies";
import { useSessionStore } from "@/stores/session-store";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";

export type { NavigateToAgentInput } from "./resolve";

export function navigateToAgent(input: NavigateToAgentInput): string {
  return resolveNavigateToAgent(input, {
    readAgentNavTarget: ({ serverId, agentId }) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        agentWorkspaceId: agent?.workspaceId,
        presentationWorkspaceId:
          agent && session
            ? resolveAgentPresentation({
                agent,
                agents: session.agents,
                workspaces: session.hasHydratedWorkspaces ? session.workspaces : undefined,
              }).workspaceId
            : undefined,
      };
    },
    navigateToHostAgent: (route) => {
      router.navigate(route as Href);
    },
    navigateToWorkspace,
  });
}
