import { useCallback, useState } from "react";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { useNavigateToImportedAgent } from "@/hooks/use-import-session";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { shouldShowWorkspaceSetup, useWorkspaceSetupStore } from "@/stores/workspace-setup-store";

export function useWorkspaceSessionMenu(serverId: string, workspaceId: string) {
  const [importOpen, setImportOpen] = useState(false);
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const directory = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  const snapshot = useWorkspaceSetupStore(
    (state) => state.snapshots[`${serverId}:${workspaceId}`] ?? null,
  );
  const navigateToImportedAgent = useNavigateToImportedAgent(serverId);
  const openImport = useCallback(() => setImportOpen(true), []);
  const closeImport = useCallback(() => setImportOpen(false), []);
  const openSetup = useCallback(() => {
    navigateToWorkspace({ serverId, workspaceId, target: { kind: "setup", workspaceId } });
  }, [serverId, workspaceId]);
  const openImportedAgent = useCallback(
    (agentId: string) => {
      navigateToWorkspace({ serverId, workspaceId, target: { kind: "agent", agentId } });
    },
    [serverId, workspaceId],
  );
  return {
    onImportSession: openImport,
    importSessionDisabled: !client || !connected || !directory,
    onShowSetup: shouldShowWorkspaceSetup(snapshot) ? openSetup : undefined,
    sheet: importOpen ? (
      <ImportSessionSheet
        visible
        client={client}
        serverId={serverId}
        workspaceId={workspaceId}
        cwd={directory}
        onClose={closeImport}
        onImportedAgent={openImportedAgent}
        onImported={navigateToImportedAgent}
      />
    ) : null,
  };
}
