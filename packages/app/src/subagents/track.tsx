import { CountBadge } from "@/components/ui/count-badge";
import { Button } from "@/components/ui/button";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { useVortonTouch } from "@/vorton-touch";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, ChevronRight, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { ComposerTrackActions, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import { getPanelManifest } from "@/panels/panel-manifest";
import type { SubagentRow } from "./select";
import type { ArchiveFinishedStatus } from "./use-archive-finished";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface SubagentsTrackProps {
  inline?: boolean;
  serverId: string;
  rows: SubagentRow[];
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onArchiveFinished?: () => void;
  archiveFinishedStatus?: ArchiveFinishedStatus;
  onDetachSubagent?: (id: string) => void;
}

const IDLE_ARCHIVE_FINISHED_STATUS: ArchiveFinishedStatus = { kind: "idle" };

/** Leading and action glyphs share one size so rows keep a single icon column. */
const ROW_ICON_SIZE = 14;

function useRowPresentation(row: SubagentRow, serverId: string): WorkspaceTabPresentation {
  const icon = useProviderIcon(row.provider, serverId);
  const data = buildSubagentRowPresentationData(row);
  return {
    ...data,
    tooltip: data.label,
    modified: false,
    showCloseButton: getPanelManifest(data.kind).showCloseButton,
    icon,
  };
}

export function SubagentsTrack({
  inline = false,
  serverId,
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onArchiveFinished,
  archiveFinishedStatus = IDLE_ARCHIVE_FINISHED_STATUS,
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);

  const pill = buildSubagentPillPresentation(t, rows);
  const headerTrailing = useMemo(
    () => (
      <>
        <CountBadge
          label={String(rows.length)}
          accessibilityLabel={pill.accessibilityLabel}
          testID="subagents-card-count"
        />
        {expanded ? (
          <ThemedChevronDown size={16} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronRight size={16} uniProps={foregroundMutedColorMapping} />
        )}
      </>
    ),
    [rows.length, pill.accessibilityLabel, expanded],
  );

  const isArchivingFinished = archiveFinishedStatus.kind === "archiving";
  const isArchiveFinishedFailed = archiveFinishedStatus.kind === "failed";
  if (rows.length === 0 && !isArchivingFinished && !isArchiveFinishedFailed) {
    return null;
  }

  const finishedCount = countFinishedSubagents(rows);
  const showArchiveFinished = finishedCount > 0 || isArchivingFinished || isArchiveFinishedFailed;

  const rowsContent = rows.map((row, index) => (
    <View
      key={`${row.kind}:${row.id}`}
      style={inline && index > 0 ? taskCardStyles.separator : undefined}
    >
      <SubagentsTrackRow
        inline={inline}
        row={row}
        serverId={serverId}
        onOpenSubagent={onOpenSubagent}
        onOpenProviderSubagent={onOpenProviderSubagent}
        onArchiveSubagent={onArchiveSubagent}
        onDetachSubagent={onDetachSubagent}
      />
    </View>
  ));
  const archiveAction =
    showArchiveFinished && onArchiveFinished ? (
      <ArchiveFinishedRow
        inline={inline}
        status={archiveFinishedStatus}
        disabled={isArchivingFinished}
        onPress={onArchiveFinished}
      />
    ) : null;
  if (inline) {
    return (
      <View style={[taskCardStyles.container, styles.card]} testID="subagents-card">
        <View style={[taskCardStyles.header, styles.cardHeader]}>
          <Button
            variant="ghost"
            size="sm"
            hitSlop={6}
            style={styles.collapseHeader}
            textStyle={styles.collapseHeaderText}
            trailing={headerTrailing}
            accessibilityLabel={t("subagents.title")}
            aria-expanded={expanded}
            testID="subagents-card-toggle"
            onPress={toggleExpanded}
          >
            {t("subagents.title")}
          </Button>
          {archiveAction}
        </View>
        {expanded ? <View style={styles.cardRows}>{rowsContent}</View> : null}
      </View>
    );
  }
  return (
    <ComposerTrackPill
      testID="subagents-track-header"
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("subagents.title")}
    >
      {archiveAction ? (
        <ComposerTrackActions divided={rows.length > 0}>{archiveAction}</ComposerTrackActions>
      ) : null}
      {rowsContent}
    </ComposerTrackPill>
  );
}

/**
 * Bulk archive, as a row above the list rather than an icon next to the count. The pill has no
 * header to hang an icon off, and a destructive-ish action reads better with its name attached.
 */
export function ArchiveFinishedRow({
  inline,
  status,
  disabled,
  onPress,
}: {
  inline?: boolean;
  status: ArchiveFinishedStatus;
  disabled: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const touch = useVortonTouch();

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <ThemedArchive
          size={ROW_ICON_SIZE}
          uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={[styles.rowLabel, inline && taskCardStyles.rowText]} numberOfLines={1}>
          {t("subagents.archiveFinishedAction")}
        </Text>
        {status.kind === "archiving" ? (
          <Text style={styles.rowTrailing} testID="subagents-track-archive-progress">
            {status.completedCount}/{status.totalCount}
          </Text>
        ) : null}
        {status.kind === "failed" ? (
          <Text style={styles.rowTrailing} testID="subagents-track-archive-failed">
            {t("subagents.archiveFinishedRetry", {
              failed: status.failedCount,
              total: status.totalCount,
            })}
          </Text>
        ) : null}
      </>
    ),
    [inline, status, t],
  );

  let actionLabel = "Archive finished";
  if (status.kind === "archiving")
    actionLabel = `Archiving ${status.completedCount}/${status.totalCount}`;
  if (status.kind === "failed") actionLabel = "Retry archive";
  if (inline) {
    return (
      <Button
        variant="outline"
        size={touch ? "md" : "xs"}
        textStyle={styles.archiveHeaderText}
        onPress={onPress}
        disabled={disabled}
        loading={status.kind === "archiving"}
        testID="subagents-track-archive-finished"
        accessibilityLabel={
          status.kind === "failed" ? "Retry archiving finished" : "Archive finished"
        }
      >
        {actionLabel}
      </Button>
    );
  }

  return (
    <ComposerTrackRow
      accessibilityLabel={t("subagents.archiveFinishedAction")}
      inline={inline}
      testID="subagents-track-archive-finished"
      disabled={disabled}
      // Progress and the retry count land on this row, so the panel is where the result of
      // pressing it shows up. Dismissing would hide the thing the press produces.
      closeOnSelect={false}
      onPress={onPress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

interface SubagentsTrackRowProps {
  inline?: boolean;
  serverId: string;
  row: SubagentRow;
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onDetachSubagent?: (id: string) => void;
}

export function SubagentsTrackRow({
  inline,
  serverId,
  row,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const presentation = useRowPresentation(row, serverId);
  const displayLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => {
    if (row.kind === "provider") {
      onOpenProviderSubagent(row.parentAgentId, row.id);
    } else {
      onOpenSubagent(row.id);
    }
  }, [onOpenProviderSubagent, onOpenSubagent, row]);
  const handleArchivePress = useCallback(() => {
    onArchiveSubagent(row.id);
  }, [onArchiveSubagent, row.id]);
  const handleDetachPress = useCallback(() => {
    onDetachSubagent?.(row.id);
  }, [onDetachSubagent, row.id]);
  const actionsAlwaysVisible = inline || isNative || isCompact;

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <WorkspaceTabIcon presentation={presentation} backdrop={active ? "surface2" : "surface1"} />
        <Text style={[styles.rowLabel, inline && taskCardStyles.rowText]} numberOfLines={1}>
          {displayLabel}
        </Text>
        {presentation.subtitle ? (
          <Text style={styles.rowTrailing} numberOfLines={1}>
            {presentation.subtitle}
          </Text>
        ) : null}
        {row.kind === "paseo" ? (
          <SubagentRowActions
            inline={inline}
            rowId={row.id}
            displayLabel={displayLabel}
            visible={actionsAlwaysVisible || active}
            onDetachPress={onDetachSubagent ? handleDetachPress : undefined}
            onArchivePress={handleArchivePress}
          />
        ) : null}
      </>
    ),
    [
      inline,
      actionsAlwaysVisible,
      displayLabel,
      handleArchivePress,
      handleDetachPress,
      onDetachSubagent,
      presentation,
      row.kind,
      row.id,
    ],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={displayLabel}
      inline={inline}
      testID={`subagents-track-row-${row.id}`}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function SubagentRowActions({
  inline,
  rowId,
  displayLabel,
  visible,
  onDetachPress,
  onArchivePress,
}: {
  inline?: boolean;
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {onDetachPress ? (
        <SubagentActionButton
          accessibilityLabel={t("subagents.detachAction", { label: displayLabel })}
          testID={`subagents-track-detach-${rowId}`}
          tooltipLabel={t("subagents.detachTooltip")}
          inline={inline}
          icon="detach"
          visible={visible}
          onPress={onDetachPress}
        />
      ) : null}
      <SubagentActionButton
        accessibilityLabel={t("subagents.archiveAction", { label: displayLabel })}
        testID={`subagents-track-archive-${rowId}`}
        tooltipLabel={t("subagents.archiveTooltip")}
        inline={inline}
        icon="archive"
        visible={visible}
        onPress={onArchivePress}
      />
    </View>
  );
}

type SubagentActionIcon = "archive" | "detach";

function renderSubagentActionIcon(
  icon: SubagentActionIcon,
  isActive: boolean,
  size: number,
): ReactElement {
  const uniProps = isActive ? foregroundColorMapping : foregroundMutedColorMapping;
  if (icon === "detach") {
    return <ThemedUnlink size={size} uniProps={uniProps} />;
  }
  return <ThemedArchive size={size} uniProps={uniProps} />;
}

function SubagentActionButton({
  inline,
  accessibilityLabel,
  testID,
  tooltipLabel,
  icon,
  visible,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  inline?: boolean;
  icon: SubagentActionIcon;
  visible: boolean;
  onPress: () => void;
}): ReactElement {
  const touch = useVortonTouch();
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={[
            styles.actionButton,
            inline && taskCardStyles.iconAction,
            touch && taskCardStyles.touchAction,
          ]}
          hitSlop={inline ? undefined : 8}
        >
          {({ hovered, pressed }) =>
            renderSubagentActionIcon(icon, hovered || pressed, inline ? 16 : ROW_ICON_SIZE)
          }
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { paddingVertical: theme.spacing[2], paddingLeft: theme.spacing[2] },
  cardHeader: { alignItems: "center" },
  cardRows: {
    marginLeft: { xs: theme.spacing[1], md: theme.spacing[2] },
  },
  archiveHeaderText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  collapseHeaderText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  collapseHeader: {
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-start",
    paddingHorizontal: theme.spacing[2],
  },
  // `flexBasis: "auto"` rather than `flex: 1`: a zero-basis label contributes nothing to the row's
  // intrinsic width, so the panel measures itself at its floor and truncates every label at once.
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  // Trailing metadata — provider context on a subagent row, progress on the archive row. No width
  // cap: the panel's own ceiling bounds it. It shrinks twice as fast as the label, so a wordy
  // provider subtitle gives way first instead of squeezing the thing that names the row.
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  touchAction: { minWidth: 44, minHeight: 44 },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
