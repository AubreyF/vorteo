import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { getIsElectron, isWeb } from "@/constants/platform";
import { isDemoSession } from "@/demo/mode";
import { isIsolatedDemoPreview } from "@/demo/preview";
import { readExecutionInstallation } from "./policy";
import {
  installationMaintenancePrompt,
  maintenanceTaskTarget,
  resolveMaintenanceTaskTarget,
  type MaintenanceTaskTarget,
} from "./maintenance-task";

/**
 * Only a page served by an installation can prove the descriptor is absent. Electron, native
 * apps and demos connect to daemons directly and never receive one.
 */
function descriptorExpected(): boolean {
  return isWeb && !getIsElectron() && !isDemoSession() && !isIsolatedDemoPreview;
}

/** Whether update and merge tasks can target a Host, for pages that explain the alternative. */
export function useMaintenanceTaskTarget(): MaintenanceTaskTarget {
  const hosts = useHosts();
  return resolveMaintenanceTaskTarget(
    readExecutionInstallation(),
    hosts.map((host) => host.serverId),
    descriptorExpected(),
  );
}

export function useMaintenanceTask() {
  const router = useRouter();
  const toast = useToast();
  const hosts = useHosts();
  return useCallback(
    (prompt: string) => {
      try {
        const serverId = maintenanceTaskTarget(
          readExecutionInstallation(),
          hosts.map((host) => host.serverId),
          descriptorExpected(),
        );
        const draftId = generateDraftId();
        useDraftStore.getState().saveDraftInput({
          draftKey: buildNewWorkspaceDraftKey(draftId),
          draft: { text: installationMaintenancePrompt(prompt), attachments: [] },
        });
        // Saving and navigating prepares an editable draft. It never creates an agent.
        router.push(buildNewWorkspaceRoute({ draftId, serverId }));
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [hosts, router, toast],
  );
}
