import { workspaceArchiveBlockReason } from "@getpaseo/protocol/workspace-lifecycle";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { queryClient } from "@/data/query-client";
import { useWorkspaceScheduleState } from "./scheduled";
import { scheduledWorkspaceStates } from "./scheduled-workspaces";

export function useWorkspaceArchiveBlockReason(
  serverId: string,
  workspaceId: string,
): string | null {
  const protectedWorkspace = useSessionStore(
    (state) => selectWorkspace(state, serverId, workspaceId)?.protected === true,
  );
  const scheduled = useWorkspaceScheduleState(serverId, workspaceId) !== undefined;
  return workspaceArchiveBlockReason({ protected: protectedWorkspace, scheduled });
}

export function getWorkspaceArchiveBlockReason(
  serverId: string,
  workspaceId: string,
): string | null {
  const state = useSessionStore.getState();
  const workspace = selectWorkspace(state, serverId, workspaceId);
  const schedules =
    queryClient.getQueryData<ScheduleSummary[]>(["schedules", "workspace-indicators", serverId]) ??
    [];
  const agents = state.sessions[serverId]?.agents ?? new Map();
  const scheduled = scheduledWorkspaceStates([{ serverId, schedules, agents }], Date.now()).has(
    `${serverId}:${workspaceId}`,
  );
  return workspaceArchiveBlockReason({ protected: workspace?.protected, scheduled });
}

export async function refreshWorkspaceArchiveBlockReason(
  client: Pick<DaemonClient, "scheduleList">,
  serverId: string,
  workspaceId: string,
): Promise<string | null> {
  const payload = await client.scheduleList();
  if (payload.error) throw new Error(payload.error);
  queryClient.setQueryData(["schedules", "workspace-indicators", serverId], payload.schedules);
  return getWorkspaceArchiveBlockReason(serverId, workspaceId);
}
