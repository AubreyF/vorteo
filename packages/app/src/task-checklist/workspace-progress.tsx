import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { workspaceChecklistProgress } from "./progress";
import { ChecklistProgressRing } from "./progress-ring";

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
      return workspaceChecklistProgress(session.agents.values(), workspaceId, pending);
    }),
  );
  if (!progress) return null;
  return (
    <ChecklistProgressRing
      {...progress}
      testID={`workspace-task-progress-${serverId}-${workspaceId}`}
    />
  );
}
