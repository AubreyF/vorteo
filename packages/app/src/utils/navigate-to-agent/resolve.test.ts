import { describe, expect, it } from "vitest";
import {
  resolveNavigateToAgent,
  type AgentNavTarget,
  type NavigateToAgentDeps,
} from "@/utils/navigate-to-agent/resolve";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

interface RecordedHostNav {
  route: string;
}

interface RecordedTabNav extends NavigateToWorkspaceInput {}

function createFakeNavigators(target: AgentNavTarget): {
  deps: NavigateToAgentDeps;
  hostNavigations: RecordedHostNav[];
  tabNavigations: RecordedTabNav[];
} {
  const hostNavigations: RecordedHostNav[] = [];
  const tabNavigations: RecordedTabNav[] = [];
  return {
    hostNavigations,
    tabNavigations,
    deps: {
      readAgentNavTarget: () => target,
      navigateToHostAgent: (route) => {
        hostNavigations.push({ route });
      },
      navigateToWorkspace: (input) => {
        tabNavigations.push(input);
        return `/h/${input.serverId}/workspace/${input.workspaceId}`;
      },
    },
  };
}

describe("resolveNavigateToAgent", () => {
  it("opens the workspace tab carried by the agent's workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });

    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true },
      deps,
    );

    expect(route).toBe("/h/server-1/workspace/workspace-1");
    expect(hostNavigations).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: true,
      },
    ]);
  });

  it("uses the input workspaceId when the cached target is unavailable", () => {
    const readTargets: { serverId: string; agentId: string }[] = [];
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: null });
    deps.readAgentNavTarget = (input) => {
      readTargets.push(input);
      return { agentWorkspaceId: null };
    };

    resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
      deps,
    );

    expect(readTargets).toEqual([{ serverId: SERVER_ID, agentId: AGENT_ID }]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: undefined,
      },
    ]);
  });

  it("falls back to the host agent route when the agent has no workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" }, deps);

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(hostNavigations).toEqual([{ route: "/h/server-1/agent/missing-agent" }]);
    expect(tabNavigations).toEqual([]);
  });
});

it("opens the original task workspace even when a worker execution workspace was supplied", () => {
  const { deps, tabNavigations } = createFakeNavigators({
    agentWorkspaceId: "execution-worktree",
    presentationWorkspaceId: "origin-task",
  });
  const route = resolveNavigateToAgent(
    { serverId: SERVER_ID, agentId: "worker", workspaceId: "execution-worktree", pin: true },
    deps,
  );
  expect(route).toBe("/h/server-1/workspace/origin-task");
  expect(tabNavigations).toEqual([
    {
      serverId: SERVER_ID,
      workspaceId: "origin-task",
      target: { kind: "agent", agentId: "worker" },
      pin: true,
    },
  ]);
});
