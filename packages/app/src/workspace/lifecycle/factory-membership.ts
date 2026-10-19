import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";

export const FACTORY_MANAGED_EXPLANATION =
  "Managed by Factory. Turn Factory off through its reconciled lifecycle before archiving or deleting this workspace.";

export function selectFactoryMembership(
  state: Pick<ReturnType<typeof useSessionStore.getState>, "sessions">,
  serverId: string,
  workspaceId: string,
) {
  const workspace = selectWorkspace(state, serverId, workspaceId);
  const info = state.sessions[serverId]?.serverInfo;
  const membership = workspace?.factoryMembership;
  const servingHostMatches = info?.serverId === serverId;
  const supportsMembership = info?.features?.factoryWorkspaceMembership === true;
  const nativeIdentityMatches =
    workspace?.id === workspaceId &&
    membership?.serverId === serverId &&
    membership?.projectId === workspace?.projectId;
  if (!servingHostMatches || !supportsMembership || !nativeIdentityMatches) return null;
  return membership ?? null;
}

export function useFactoryMembership(serverId: string, workspaceId: string) {
  return useSessionStore((state) => selectFactoryMembership(state, serverId, workspaceId));
}
