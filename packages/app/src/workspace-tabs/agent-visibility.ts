import { workspaceEnvironmentMembers } from "@/task-environments/workspaces";
import type { SessionState } from "@/stores/session-store";
import type { WorkspaceTabTarget } from "./model";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { getAgentPresentationIndex } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  agentTargets?: Record<string, WorkspaceTabTarget>;
  hydratedEnvironmentIds?: Set<string>;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
  workspaces?: Map<string, WorkspaceDescriptor>;
}): WorkspaceAgentVisibility {
  const { sessionAgents } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!sessionAgents || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const presentations = getAgentPresentationIndex(sessionAgents, input.workspaces);
  for (const agent of sessionAgents.values()) {
    const presentation = presentations.get(agent.id);
    if (presentation?.workspaceId !== workspaceId) {
      continue;
    }
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      if (presentation.rootAgentId === agent.id) {
        autoOpenAgentIds.add(agent.id);
      }
    }
  }
  return { activeAgentIds, autoOpenAgentIds };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingTerminalCreate: boolean;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    agentTargets: input.agentVisibility.agentTargets,
    hydratedEnvironmentIds: input.agentVisibility.hydratedEnvironmentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingTerminalCreate: input.hasActivePendingTerminalCreate,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    JSON.stringify(a.agentTargets) === JSON.stringify(b.agentTargets) &&
    setsEqual(a.hydratedEnvironmentIds ?? new Set(), b.hydratedEnvironmentIds ?? new Set())
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}

export function deriveEnvironmentWorkspaceAgentVisibility(input: {
  sessions: Record<
    string,
    Pick<
      SessionState,
      "agents" | "agentDetails" | "workspaces" | "hasHydratedAgents" | "hasHydratedWorkspaces"
    >
  >;
  serverId: string;
  workspaceId: string;
}): WorkspaceAgentVisibility {
  const members = workspaceEnvironmentMembers(input.sessions, input);
  const combined: WorkspaceAgentVisibility = {
    activeAgentIds: new Set(),
    autoOpenAgentIds: new Set(),
    agentTargets: {},
  };
  const targets: Record<string, WorkspaceTabTarget> = {};
  for (const member of members) {
    const session = input.sessions[member.serverId];
    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: session?.agents,
      agentDetails: session?.agentDetails,
      workspaceId: member.workspaceId,
      workspaces: session?.workspaces,
    });
    for (const agentId of visibility.activeAgentIds) combined.activeAgentIds.add(agentId);
    for (const agentId of visibility.autoOpenAgentIds) {
      combined.autoOpenAgentIds.add(agentId);
      const remote = member.serverId !== input.serverId || member.workspaceId !== input.workspaceId;
      targets[agentId] = remote
        ? { kind: "agent", agentId, environment: member }
        : { kind: "agent", agentId };
    }
  }
  // A destination may hydrate first. Preserve its saved tabs until the owner can
  // establish the complete workspace group.
  const owner = input.sessions[input.serverId];
  const ownerReady = owner?.hasHydratedWorkspaces && owner.workspaces.has(input.workspaceId);
  combined.hydratedEnvironmentIds = new Set(
    Object.entries(input.sessions)
      .filter(
        ([, session]) => ownerReady && session.hasHydratedAgents && session.hasHydratedWorkspaces,
      )
      .map(([serverId]) => serverId),
  );
  combined.agentTargets = targets;
  return combined;
}

/** Timeline updates retain these maps; avoid rescanning workspaces on every streamed token. */
export function createEnvironmentWorkspaceVisibilitySelector(reference: {
  serverId: string;
  workspaceId: string;
}) {
  let previous: SessionState[] = [];
  let result: WorkspaceAgentVisibility = { activeAgentIds: new Set(), autoOpenAgentIds: new Set() };
  return (state: { sessions: Record<string, SessionState> }) => {
    const sessions = Object.values(state.sessions);
    const unchanged =
      sessions.length === previous.length &&
      sessions.every((session, index) => {
        const old = previous[index];
        return (
          old &&
          session.serverId === old.serverId &&
          session.workspaces === old.workspaces &&
          session.agents === old.agents &&
          session.hasHydratedAgents === old.hasHydratedAgents &&
          session.hasHydratedWorkspaces === old.hasHydratedWorkspaces
        );
      });
    if (unchanged) return result;
    previous = sessions;
    result = deriveEnvironmentWorkspaceAgentVisibility({ ...reference, sessions: state.sessions });
    return result;
  };
}
