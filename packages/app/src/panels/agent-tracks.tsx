import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSubagentsForParent, useArchiveFinishedSubagents } from "@/subagents";
import { useHasPluginComposerPills } from "@/plugins";
import { memo, useCallback, type ReactElement } from "react";

import { AgentTaskList } from "@/composer/task-list";

import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { PluginComposerPills } from "@/plugins";
import { useSessionStore } from "@/stores/session-store";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  type SubagentRow,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import type { TodoEntry } from "@/types/stream";
import { resolveAgentPresentation } from "@/subagents/policies";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";

export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  agentId,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
  hasPluginComposerPills,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  cwd: string;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
  hasPluginComposerPills: boolean;
}): ReactElement | null {
  const { tabId, openTab } = usePaneContext();

  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      const presentation =
        agent && session
          ? resolveAgentPresentation({
              agent,
              agents: session.agents,
              workspaces: session.hasHydratedWorkspaces ? session.workspaces : undefined,
            })
          : null;
      if (presentation?.workspaceId && presentation.workspaceId !== workspaceId) {
        navigateToAgent({ serverId, agentId: subagentId });
        return;
      }
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "agent", agentId: subagentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
        });
        return;
      }
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [canSplit, isCompact, openInSidePane, serverId, tabId, workspaceId, workspaceKey],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "provider_subagent", parentAgentId, subagentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
        });
        return;
      }
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [canSplit, isCompact, openInSidePane, openTab, tabId, workspaceKey],
  );

  if (
    !hasAgentTracks({
      subagentRows,
      tasks,
      archiveFinishedStatus,
      hasPluginComposerPills,
    })
  ) {
    return null;
  }

  return (
    <>
      {hasPluginComposerPills ? (
        <View style={styles.pills} testID="agent-history-plugin-pills">
          <PluginComposerPills
            serverId={serverId}
            workspaceId={workspaceId}
            agentId={agentId}
            compact={isCompact}
          />
        </View>
      ) : null}
      <SubagentsTrack
        inline
        serverId={serverId}
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <AgentTaskList inline tasks={tasks} />
    </>
  );
});

export function hasAgentTracks({
  subagentRows,
  tasks,
  archiveFinishedStatus,
  hasPluginComposerPills = false,
}: {
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  hasPluginComposerPills?: boolean;
}): boolean {
  return (
    subagentRows.length > 0 ||
    Boolean(tasks?.length) ||
    archiveFinishedStatus.kind !== "idle" ||
    hasPluginComposerPills
  );
}

export function AgentHistoryTracks({
  serverId,
  workspaceId,
  agentId,
  cwd,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  cwd: string;
}) {
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const tasks = useSessionStore((state) => state.sessions[serverId]?.agentTasks.get(agentId));
  const archive = useArchiveFinishedSubagents({
    serverId,
    parentAgentId: agentId,
    rows: subagentRows,
  });
  const hasPluginComposerPills = useHasPluginComposerPills(serverId, workspaceId, agentId);
  return (
    <AgentTracks
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      cwd={cwd}
      subagentRows={subagentRows}
      tasks={tasks}
      archiveFinishedStatus={archive.status}
      onArchiveFinished={archive.archiveFinished}
      hasPluginComposerPills={hasPluginComposerPills}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  pills: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1], alignItems: "center" },
}));
