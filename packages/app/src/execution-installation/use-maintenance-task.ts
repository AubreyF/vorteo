import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { readExecutionInstallation } from "./policy";
import { installationMaintenancePrompt, maintenanceTaskTarget } from "./maintenance-task";

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
