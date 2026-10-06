import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";

type WorkspaceAgent = Pick<Agent, "parentAgentId" | "workspaceId">;

export function isWorkspaceRootAgent(
  agent: WorkspaceAgent,
  parentAgent: Pick<Agent, "workspaceId"> | undefined,
): boolean {
  if (!agent.parentAgentId) {
    return true;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  const parentWorkspaceId = normalizeWorkspaceOpaqueId(parentAgent?.workspaceId);
  return Boolean(workspaceId && parentWorkspaceId && workspaceId !== parentWorkspaceId);
}

export interface AgentPresentation {
  rootAgentId: string;
  workspaceId: string | null;
}

type PresentationAgent = Pick<Agent, "id" | "workspaceId" | "parentAgentId" | "archivedAt">;

export function resolveAgentPresentation(input: {
  agent: PresentationAgent;
  agents: ReadonlyMap<string, PresentationAgent>;
  workspaces?: Map<string, WorkspaceDescriptor>;
}): AgentPresentation {
  const own = {
    rootAgentId: input.agent.id,
    workspaceId: normalizeWorkspaceOpaqueId(input.agent.workspaceId),
  };
  if (input.agent.archivedAt) return own;
  if (input.workspaces && own.workspaceId) {
    const workspaceKey = resolveWorkspaceMapKeyByIdentity({
      workspaces: input.workspaces,
      workspaceId: own.workspaceId,
    });
    const workspace = workspaceKey ? input.workspaces.get(workspaceKey) : undefined;
    // Keep recovery attached to the execution workspace if it is no longer available.
    if (!workspace || workspace.archivingAt) return own;
  }

  const visited = new Set([input.agent.id]);
  let current = input.agent;
  while (current.parentAgentId) {
    const parent = input.agents.get(current.parentAgentId);
    if (!parent || parent.archivedAt) break;
    if (visited.has(parent.id)) return own;
    const workspaceId = normalizeWorkspaceOpaqueId(parent.workspaceId);
    if (!workspaceId) break;
    if (input.workspaces) {
      const workspaceKey = resolveWorkspaceMapKeyByIdentity({
        workspaces: input.workspaces,
        workspaceId,
      });
      const workspace = workspaceKey ? input.workspaces.get(workspaceKey) : undefined;
      if (!workspace || workspace.archivingAt) break;
    }
    visited.add(parent.id);
    current = parent;
  }
  return {
    rootAgentId: current.id,
    workspaceId: normalizeWorkspaceOpaqueId(current.workspaceId),
  };
}

const noWorkspaceContext = new Map<string, WorkspaceDescriptor>();
const presentationIndexes = new WeakMap<
  ReadonlyMap<string, PresentationAgent>,
  WeakMap<Map<string, WorkspaceDescriptor>, ReadonlyMap<string, AgentPresentation>>
>();

export function getAgentPresentationIndex(
  agents: ReadonlyMap<string, PresentationAgent>,
  workspaces?: Map<string, WorkspaceDescriptor>,
): ReadonlyMap<string, AgentPresentation> {
  const context = workspaces ?? noWorkspaceContext;
  let contexts = presentationIndexes.get(agents);
  const cached = contexts?.get(context);
  if (cached) return cached;
  const index = new Map<string, AgentPresentation>();
  for (const agent of agents.values())
    index.set(agent.id, resolveAgentPresentation({ agent, agents, workspaces }));
  if (!contexts) {
    contexts = new WeakMap();
    presentationIndexes.set(agents, contexts);
  }
  contexts.set(context, index);
  return index;
}
