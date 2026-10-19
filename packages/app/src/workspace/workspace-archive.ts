import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  getWorkspaceArchiveBlockReason,
  refreshWorkspaceArchiveBlockReason,
} from "./lifecycle/archive";
import { workspaceEnvironmentMembers } from "@/task-environments/workspaces";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  clearWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { i18n } from "@/i18n/i18next";
import {
  FACTORY_MANAGED_EXPLANATION,
  selectFactoryMembership,
} from "./lifecycle/factory-membership";

export interface WorkspaceArchiveTarget {
  serverId: string;
  workspaceId: string;
}

interface WorkspaceArchiveClient extends Pick<DaemonClient, "scheduleList"> {
  archiveWorkspace: (workspaceId: string) => Promise<{ error: string | null }>;
}

interface OptimisticWorkspaceArchiveSnapshot {
  workspace: WorkspaceDescriptor | null;
}

export interface WorkspaceArchiveFailure {
  serverId: string;
  workspaceId: string;
  error: unknown;
}

function isWorkspaceArchiveFailure(error: unknown): error is WorkspaceArchiveFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "serverId" in error &&
    typeof error.serverId === "string" &&
    "workspaceId" in error &&
    typeof error.workspaceId === "string" &&
    "error" in error
  );
}

function hideWorkspaceOptimistically(
  workspace: WorkspaceArchiveTarget,
): OptimisticWorkspaceArchiveSnapshot {
  const workspaces = useSessionStore.getState().sessions[workspace.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: workspace.workspaceId,
  });
  const snapshot = workspaceKey ? (workspaces?.get(workspaceKey) ?? null) : null;
  markWorkspaceArchivePending({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  getHostRuntimeStore().removeWorkspaceSnapshot(workspace.serverId, workspace.workspaceId);
  return { workspace: snapshot };
}

function restoreOptimisticallyHiddenWorkspace(input: {
  serverId: string;
  workspaceId: string;
  snapshot: OptimisticWorkspaceArchiveSnapshot;
}): void {
  clearWorkspaceArchivePending({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (input.snapshot.workspace) {
    getHostRuntimeStore().acceptWorkspaceSnapshots(input.serverId, [input.snapshot.workspace]);
  }
}

async function archiveWorkspaceOrThrow(input: {
  client: WorkspaceArchiveClient;
  workspaceId: string;
}): Promise<void> {
  const payload = await input.client.archiveWorkspace(input.workspaceId);
  if (payload.error) {
    throw new Error(payload.error);
  }
}

function assertArchiveTargetsCurrent(targets: readonly WorkspaceArchiveTarget[]): void {
  for (const workspace of targets) {
    if (
      selectFactoryMembership(useSessionStore.getState(), workspace.serverId, workspace.workspaceId)
    )
      throw new Error(FACTORY_MANAGED_EXPLANATION);
    const reason = getWorkspaceArchiveBlockReason(workspace.serverId, workspace.workspaceId);
    if (reason) throw new Error(reason);
  }
}

export async function archiveWorkspaceOptimistically(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  getCompanionClient?: (serverId: string) => WorkspaceArchiveClient | null;
  onArchiveStarted?: () => void;
}): Promise<void> {
  assertArchiveTargetsCurrent([input.workspace]);
  const members = workspaceEnvironmentMembers(useSessionStore.getState().sessions, input.workspace);
  const isOwner =
    members[0]?.serverId === input.workspace.serverId &&
    members[0]?.workspaceId === input.workspace.workspaceId;
  const companions = (isOwner ? members : []).filter(
    (member) =>
      member.serverId !== input.workspace.serverId ||
      member.workspaceId !== input.workspace.workspaceId,
  );
  const targets = [input.workspace, ...companions];
  assertArchiveTargetsCurrent(targets);
  const getCompanionClient =
    input.getCompanionClient ?? ((serverId: string) => getHostRuntimeStore().getClient(serverId));
  const operations = companions.map((workspace) => {
    const client = getCompanionClient(workspace.serverId);
    if (!client) throw new Error("Reconnect all workspace environments before archiving.");
    return { client, workspace };
  });
  // Refresh every member before the first irreversible archive, not just the selected owner.
  for (const operation of [input, ...operations]) {
    const freshReason = await refreshWorkspaceArchiveBlockReason(
      operation.client,
      operation.workspace.serverId,
      operation.workspace.workspaceId,
    );
    if (freshReason) throw new Error(freshReason);
    assertArchiveTargetsCurrent(targets);
  }
  assertArchiveTargetsCurrent(targets);
  input.onArchiveStarted?.();
  assertArchiveTargetsCurrent(targets);
  for (const operation of operations) {
    assertArchiveTargetsCurrent(targets);
    await archiveWorkspaceOrThrow({
      client: operation.client,
      workspaceId: operation.workspace.workspaceId,
    });
    assertArchiveTargetsCurrent(targets);
    getHostRuntimeStore().removeWorkspaceSnapshot(
      operation.workspace.serverId,
      operation.workspace.workspaceId,
    );
  }
  assertArchiveTargetsCurrent(targets);
  const snapshot = hideWorkspaceOptimistically(input.workspace);

  try {
    assertArchiveTargetsCurrent(targets);
    await archiveWorkspaceOrThrow({
      client: input.client,
      workspaceId: input.workspace.workspaceId,
    });
  } catch (error) {
    restoreOptimisticallyHiddenWorkspace({
      serverId: input.workspace.serverId,
      workspaceId: input.workspace.workspaceId,
      snapshot,
    });
    throw error;
  }
}

export async function archiveWorkspacesOptimistically(input: {
  getClient: (serverId: string) => WorkspaceArchiveClient | null;
  workspaces: WorkspaceArchiveTarget[];
}): Promise<WorkspaceArchiveFailure[]> {
  const results = await Promise.allSettled(
    input.workspaces.map(async (workspace) => {
      const client = input.getClient(workspace.serverId);
      if (!client) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error: new Error(i18n.t("sidebar.workspace.toasts.hostDisconnected")),
        } satisfies WorkspaceArchiveFailure;
      }

      try {
        await archiveWorkspaceOptimistically({
          client,
          workspace,
        });
      } catch (error) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error,
        } satisfies WorkspaceArchiveFailure;
      }
    }),
  );

  return results.flatMap((result) =>
    result.status === "rejected" && isWorkspaceArchiveFailure(result.reason) ? [result.reason] : [],
  );
}
