import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { selectHostFeature } from "@/runtime/host-features";

interface ProjectRemoveHost {
  serverId: string;
  projectId: string;
}

export interface ProjectRemoveProject {
  hosts: readonly ProjectRemoveHost[];
}

export interface ProjectRemoveTarget {
  serverId: string;
  projectId: string;
}

export type ProjectRemoveReadiness =
  | { kind: "ready"; targets: ProjectRemoveTarget[] }
  | { kind: "needs_host_update"; serverIds: string[] };

export type ProjectRemoveOutcome =
  | { kind: "removed"; serverIds: string[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "failed"; serverIds: string[] };

type ProjectRemoveClient = Pick<DaemonClient, "removeProject" | "archiveWorkspace">;

export function getProjectRemoveReadiness(input: {
  project: ProjectRemoveProject;
  supportsProjectRemove: (serverId: string) => boolean;
}): ProjectRemoveReadiness {
  const unsupportedServerIds: string[] = [];
  const targets: ProjectRemoveTarget[] = [];

  for (const host of input.project.hosts) {
    if (!input.supportsProjectRemove(host.serverId)) {
      unsupportedServerIds.push(host.serverId);
      continue;
    }
    targets.push({
      serverId: host.serverId,
      projectId: host.projectId,
    });
  }

  if (unsupportedServerIds.length > 0) {
    return { kind: "needs_host_update", serverIds: unsupportedServerIds };
  }

  return { kind: "ready", targets };
}

export function getCurrentProjectRemoveReadiness(
  project: ProjectRemoveProject,
): ProjectRemoveReadiness {
  const sessionState = useSessionStore.getState();
  return getProjectRemoveReadiness({
    project,
    supportsProjectRemove: (serverId) => selectHostFeature(sessionState, serverId, "projectRemove"),
  });
}

interface ProjectRemoveInput {
  targets: readonly ProjectRemoveTarget[];
  workspaces?: readonly { serverId: string; workspaceId: string }[];
  getClient: (serverId: string) => ProjectRemoveClient | null;
}

function assertProjectUnprotected(input: ProjectRemoveInput): void {
  const sessionState = useSessionStore.getState();
  const protectionError =
    "This project contains a protected workspace. Remove protection before removing the project.";
  for (const workspace of input.workspaces ?? []) {
    if (selectWorkspace(sessionState, workspace.serverId, workspace.workspaceId)?.protected) {
      throw new Error(protectionError);
    }
  }
  // Project removal also archives native members hidden by sidebar filters.
  for (const target of input.targets) {
    const workspaces = sessionState.sessions[target.serverId]?.workspaces.values() ?? [];
    for (const workspace of workspaces) {
      const nativeMember = workspace.projectId === target.projectId && !workspace.projectMembership;
      if (nativeMember && workspace.protected) throw new Error(protectionError);
    }
  }
}

export async function removeProjectFromHosts(
  input: ProjectRemoveInput,
): Promise<ProjectRemoveOutcome> {
  assertProjectUnprotected(input);
  const clients: Array<{ serverId: string; projectId: string; client: ProjectRemoveClient }> = [];
  const disconnectedServerIds: string[] = [];
  const workspaceClients = (input.workspaces ?? []).map((workspace) => ({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    client: input.getClient(workspace.serverId),
  }));
  for (const workspace of workspaceClients) {
    if (!workspace.client) disconnectedServerIds.push(workspace.serverId);
  }

  for (const target of input.targets) {
    const client = input.getClient(target.serverId);
    if (!client) {
      disconnectedServerIds.push(target.serverId);
      continue;
    }
    clients.push({ serverId: target.serverId, projectId: target.projectId, client });
  }

  if (disconnectedServerIds.length > 0) {
    return { kind: "host_disconnected", serverIds: disconnectedServerIds };
  }

  for (const workspace of workspaceClients) {
    if (!workspace.client) continue;
    const result = await workspace.client.archiveWorkspace(workspace.workspaceId);
    if (result.error) return { kind: "failed", serverIds: [workspace.serverId] };
  }

  const results = await Promise.allSettled(
    clients.map(async ({ client, projectId }) => {
      await client.removeProject(projectId);
    }),
  );
  const failedServerIds: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const failed = clients[index];
      if (failed) {
        failedServerIds.push(failed.serverId);
      }
    }
  }

  if (failedServerIds.length > 0) {
    return { kind: "failed", serverIds: failedServerIds };
  }

  return { kind: "removed", serverIds: clients.map((entry) => entry.serverId) };
}
