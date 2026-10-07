import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { useEffect, useState, useSyncExternalStore } from "react";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  findInstallationEnvironment,
  readExecutionInstallation,
} from "@/execution-installation/policy";
import { openTaskEnvironment, type TaskEnvironmentState } from "./model";
import { sameWorkspaceReference, workspaceOwner } from "./workspaces";

export function useTaskEnvironment(directory: string) {
  const pane = usePaneContext();
  const [model] = useState(() => {
    const sessions = useSessionStore.getState().sessions;
    const workspace = sessions[pane.serverId]?.workspaces.get(pane.workspaceId);
    const requestedOwner = workspaceOwner(pane, workspace);
    const owner = sessions[requestedOwner.serverId]?.workspaces.has(requestedOwner.workspaceId)
      ? requestedOwner
      : { serverId: pane.serverId, workspaceId: pane.workspaceId };
    const projects = selectWorkspaceStructureProjects(
      useSessionStore.getState(),
      Object.keys(sessions),
    );
    const project = projects.find((item) =>
      item.workspaceKeys.includes(`${owner.serverId}:${owner.workspaceId}`),
    );
    const saved = pane.state;
    const ownerWorkspace = sessions[owner.serverId]?.workspaces.get(owner.workspaceId);
    const ownWorkspace = sameWorkspaceReference(owner, pane);
    const ownerDirectory = ownWorkspace
      ? directory
      : (ownerWorkspace?.workspaceDirectory ?? directory);
    let selection: TaskEnvironmentState | undefined;
    if (!ownWorkspace) {
      selection = {
        serverId: pane.serverId,
        directory,
        workspaceId: pane.workspaceId,
        status: "ready",
        error: null,
      };
    }
    selection = readSavedSelection(saved) ?? selection;
    return openTaskEnvironment({
      owner,
      directory: ownerDirectory,
      name: workspace?.name ?? "Workspace",
      project: {
        key: project?.viewKey ?? workspace?.projectId ?? pane.workspaceId,
        name: project?.projectName ?? workspace?.projectDisplayName ?? "Project",
      },
      saved: selection,
      async getClient(serverId) {
        if (getHostRuntimeStore().getSnapshot(serverId)?.connectionStatus !== "online") {
          await getHostRuntimeStore().runProbeCycleNow(serverId);
        }
        const session = useSessionStore.getState().sessions[serverId];
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client || getHostRuntimeStore().getSnapshot(serverId)?.connectionStatus !== "online")
          throw new Error("This environment is offline. Reconnect, then retry.");
        return {
          client,
          supportsBindings: session?.serverInfo?.features?.workspaceTaskEnvironments === true,
        };
      },
      async approveHost(serverId) {
        const environment = findInstallationEnvironment(readExecutionInstallation(), serverId);
        if (environment?.kind !== "host") return true;
        return confirmDialog({
          title: "Run on the host?",
          message:
            "Agents and terminals here have full access to your host account, including its files and credentials.",
          confirmLabel: "Use host",
        });
      },
      save(state) {
        pane.setCurrentTabState({
          serverId: state.serverId,
          directory: state.directory,
          workspaceId: state.workspaceId,
        });
      },
    });
  });
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState);
  return { model, state };
}

function readSavedSelection(saved: JsonValue | undefined): TaskEnvironmentState | undefined {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return undefined;
  if (typeof saved.serverId !== "string" || typeof saved.directory !== "string") return undefined;
  if (saved.workspaceId !== null && typeof saved.workspaceId !== "string") return undefined;
  return {
    serverId: saved.serverId,
    directory: saved.directory,
    workspaceId: saved.workspaceId,
    status: saved.directory ? "ready" : "folder",
    error: null,
  };
}
