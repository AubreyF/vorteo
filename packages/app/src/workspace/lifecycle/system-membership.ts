import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace, type SessionsSnapshot } from "@/stores/session-store-hooks/selectors";
import { isSystemManagedWorkspace } from "./system-workspace";

export { SYSTEM_MANAGED_EXPLANATION } from "./system-workspace";

export function selectSystemManaged(
  state: SessionsSnapshot,
  serverId: string,
  workspaceId: string,
): boolean {
  return isSystemManagedWorkspace(
    selectWorkspace(state, serverId, workspaceId),
    state.sessions[serverId]?.serverInfo?.features?.systemProject === true,
  );
}

export function useSystemManaged(serverId: string, workspaceId: string): boolean {
  return useSessionStore((state) => selectSystemManaged(state, serverId, workspaceId));
}

/** The System project is recognised by its members' markers; projects carry no marker. */
export function selectIsSystemProject(
  state: SessionsSnapshot,
  serverId: string,
  projectId: string,
): boolean {
  const session = state.sessions[serverId];
  if (session?.serverInfo?.features?.systemProject !== true) return false;
  for (const workspace of session.workspaces.values()) {
    if (workspace.projectId === projectId && workspace.projectSystem) return true;
  }
  return false;
}

export function useIsSystemProject(serverId: string, projectId: string): boolean {
  return useSessionStore((state) => selectIsSystemProject(state, serverId, projectId));
}

/** A sidebar project spans hosts; it is the System project when any host's copy is. */
export function useIsSystemProjectOnAnyHost(
  hosts: readonly { serverId: string; projectId: string }[],
): boolean {
  return useSessionStore((state) =>
    hosts.some((host) => selectIsSystemProject(state, host.serverId, host.projectId)),
  );
}

/** `serverId:workspaceId` keys of system-managed workspaces on hosts that advertise them. */
export function selectSystemManagedWorkspaceKeys(state: SessionsSnapshot): string[] {
  const keys: string[] = [];
  for (const [serverId, session] of Object.entries(state.sessions)) {
    const supported = session.serverInfo?.features?.systemProject === true;
    for (const workspace of session.workspaces.values()) {
      if (isSystemManagedWorkspace(workspace, supported)) keys.push(`${serverId}:${workspace.id}`);
    }
  }
  return keys;
}
