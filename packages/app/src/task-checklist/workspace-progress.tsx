import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { selectSystemManaged } from "@/workspace/lifecycle/system-membership";
import { workspaceChecklistProgress } from "./progress";
import { ChecklistProgressFlower } from "./progress-flower";

export function WorkspaceChecklistProgress({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const pending = usePendingArchiveAgentIds(serverId);
  const progress = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      if (!session?.serverInfo?.features?.agentTaskSnapshots) return null;
      // System-managed workspaces stay out of completion progress.
      if (selectSystemManaged(state, serverId, workspaceId)) return null;
      return workspaceChecklistProgress(session.agents.values(), workspaceId, pending);
    }),
  );
  if (!progress) return null;
  return (
    <ChecklistProgressFlower
      {...progress}
      testID={`workspace-task-progress-${serverId}-${workspaceId}`}
    />
  );
}
