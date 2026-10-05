import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSubagentsForParent, useArchiveFinishedSubagents } from "@/subagents";
import { useHasPluginComposerPills } from "@/plugins";
import { memo, useCallback, type ReactElement } from "react";
import { useVortonMode } from "@/vorton-mode";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
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
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openComposerChanges } from "@/workspace-tabs/open-supporting-view";

/**
 * Paseo keeps the composer pill rail. Vorton renders the same context and actions in
 * the conversation footer, so navigation and lifecycle behavior have one owner.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  agentId,
  cwd,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
  hasPluginComposerPills,
  inline = false,
}: {
  inline?: boolean;
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
  const vortonMode = useVortonMode();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId);
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
      if (agent?.workspaceId && agent.workspaceId !== workspaceId) {
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
  const handleOpenChanges = useCallback(() => {
    if (!workspaceKey) {
      return;
    }
    openComposerChanges({
      isCompact,
      workspaceKey,
      checkout: { serverId, cwd, isGit: true },
      preferences: openInSidePane,
    });
  }, [cwd, isCompact, openInSidePane, serverId, workspaceKey]);

  if (vortonMode !== inline) return null;

  if (
    (inline || !hasWorkspaceDiffStat) &&
    !hasAgentTracks({
      subagentRows,
      tasks,
      archiveFinishedStatus,
      hasPluginComposerPills,
    })
  ) {
    return null;
  }

  if (inline) {
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
  }

  return (
    <ComposerTrackBar>
      <AgentTaskList tasks={tasks} />
      <SubagentsTrack
        serverId={serverId}
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <PluginComposerPills
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        compact={isCompact}
      />
      {!vortonMode && (
        <WorkspaceDiffStatPill
          serverId={serverId}
          workspaceId={workspaceId}
          onPress={handleOpenChanges}
        />
      )}
    </ComposerTrackBar>
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
      inline
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
