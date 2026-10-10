import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import {
  TaskCard,
  TaskCardHeader,
  TaskCardAction,
  TaskCardActions,
  TaskCardInfo,
} from "@/agent-stream/task-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { CountBadge } from "@/components/ui/count-badge";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { useVortonTouch } from "@/vorton-touch";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, Unlink, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
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
import { isFinishedSubagent } from "./archive-finished";
import { useProviderSubagentStore } from "./provider-store";
import type { ArchiveFinishedStatus } from "./use-archive-finished";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
} from "./track-presentation";

const ThemedX = withUnistyles(X);
const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);

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
  const pill = buildSubagentPillPresentation(t, rows);
  if (rows.length === 0 && archiveFinishedStatus.kind === "idle") return null;

  const groups = (["paseo", "provider"] as const).map((kind) => (
    <SubagentsGroup
      key={kind}
      kind={kind}
      cardTestID={
        kind === "paseo" || !rows.some((row) => row.kind === "paseo")
          ? "subagents-card"
          : "provider-subagents-card"
      }
      inline={inline}
      serverId={serverId}
      rows={rows.filter((row) => row.kind === kind)}
      onOpenSubagent={onOpenSubagent}
      onOpenProviderSubagent={onOpenProviderSubagent}
      onArchiveSubagent={onArchiveSubagent}
      onDetachSubagent={onDetachSubagent}
      onArchiveFinished={onArchiveFinished}
      archiveFinishedStatus={archiveFinishedStatus}
    />
  ));
  if (inline) {
    return <View style={styles.groups}>{groups}</View>;
  }
  return (
    <ComposerTrackPill
      testID="subagents-track-header"
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("subagents.title")}
    >
      {groups}
    </ComposerTrackPill>
  );
}

interface SubagentsGroupProps extends SubagentsTrackProps {
  kind: SubagentRow["kind"];
  cardTestID: string;
}

function SubagentsGroup({
  kind,
  cardTestID,
  inline,
  serverId,
  rows,
  onArchiveFinished,
  archiveFinishedStatus = IDLE_ARCHIVE_FINISHED_STATUS,
  ...rowActions
}: SubagentsGroupProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const status = kind === "paseo" ? archiveFinishedStatus : IDLE_ARCHIVE_FINISHED_STATUS;
  const clearFinished = useCallback(() => {
    if (kind === "paseo") {
      onArchiveFinished?.();
      return;
    }
    for (const row of rows) {
      if (row.kind === "provider" && isFinishedSubagent(row)) {
        useProviderSubagentStore.getState().hideFromTrack(serverId, row.parentAgentId, [row.id]);
      }
    }
  }, [kind, onArchiveFinished, rows, serverId]);
  const title = kind === "paseo" ? t("subagents.workersTitle") : t("subagents.providerTitle");
  const countBadge = useMemo(
    () => <CountBadge label={String(rows.length)} accessibilityLabel={title} />,
    [rows.length, title],
  );
  if (rows.length === 0 && status.kind === "idle") return null;
  const canClear = kind === "provider" || Boolean(onArchiveFinished);
  const showClear = canClear && (countFinishedSubagents(rows) > 0 || status.kind !== "idle");
  const header = (
    <>
      <CardDisclosure
        icon={HEADING_ICON}
        title={title}
        expanded={expanded}
        onPress={toggleExpanded}
        testID={`subagents-group-${kind}-toggle`}
        count={countBadge}
      />
      <TaskCardActions>
        <TaskCardInfo
          label={t("settings.groupInfo", { title })}
          testID={`subagents-group-${kind}-info`}
        >
          {kind === "paseo" ? t("subagents.workersInfo") : t("subagents.providerInfo")}
        </TaskCardInfo>
        {showClear ? (
          <ArchiveFinishedRow
            inline
            status={status}
            disabled={status.kind === "archiving"}
            onPress={clearFinished}
          />
        ) : null}
      </TaskCardActions>
    </>
  );
  const body = expanded ? (
    <View style={styles.cardRows}>
      {rows.map((row) => (
        <SubagentsTrackRow
          key={row.id}
          inline={inline}
          row={row}
          serverId={serverId}
          {...rowActions}
        />
      ))}
    </View>
  ) : null;
  return (
    <View testID={`subagents-group-${kind}`}>
      {inline ? (
        <TaskCard bodyVisible={expanded} testID={cardTestID}>
          <TaskCardHeader>{header}</TaskCardHeader>

          {body}
        </TaskCard>
      ) : (
        <>
          <TaskCardHeader>{header}</TaskCardHeader>
          {body}
        </>
      )}
    </View>
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

  let actionLabel = t("subagents.archiveFinishedAction");
  if (status.kind === "archiving")
    actionLabel = `Clearing ${status.completedCount}/${status.totalCount}`;
  if (status.kind === "failed") actionLabel = "Retry cleanup";
  if (inline) {
    return (
      <TaskCardAction
        onPress={onPress}
        disabled={disabled}
        loading={status.kind === "archiving"}
        testID="subagents-track-archive-finished"
        accessibilityLabel={
          status.kind === "failed"
            ? "Retry clearing finished"
            : t("subagents.archiveFinishedAction")
        }
      >
        {actionLabel}
      </TaskCardAction>
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
    if (row.kind === "provider") {
      useProviderSubagentStore.getState().hideFromTrack(serverId, row.parentAgentId, [row.id]);
      return;
    }
    onArchiveSubagent(row.id);
  }, [onArchiveSubagent, row, serverId]);
  const handleDetachPress = useCallback(() => {
    onDetachSubagent?.(row.id);
  }, [onDetachSubagent, row.id]);
  const actionsAlwaysVisible = inline || isNative || isCompact;
  const canArchive = row.kind === "paseo" || isFinishedSubagent(row);
  const canDetach = row.kind === "paseo" && Boolean(onDetachSubagent);

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <WorkspaceTabIcon presentation={presentation} backdrop={active ? "surface2" : "surface1"} />
        <Text
          style={[styles.rowLabel, inline && taskCardStyles.rowText]}
          numberOfLines={1}
          testID={`subagents-track-label-${row.id}`}
        >
          {displayLabel}
        </Text>
        {row.kind === "provider" ? (
          <StatusBadge label={t(`subagents.providerStatus.${row.status}`)} size="xs" />
        ) : null}
        {presentation.subtitle ? (
          <Text
            style={[styles.rowTrailing, styles.rowMetadata]}
            numberOfLines={1}
            accessibilityLabel={presentation.subtitle}
            testID={`subagents-track-metadata-${row.id}`}
            selectable
          >
            {presentation.subtitle}
          </Text>
        ) : null}
        {canArchive ? (
          <SubagentRowActions
            inline={inline}
            rowId={row.id}
            displayLabel={displayLabel}
            visible={actionsAlwaysVisible || active}
            onDetachPress={canDetach ? handleDetachPress : undefined}
            onArchivePress={handleArchivePress}
            providerNative={row.kind === "provider"}
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
      canArchive,
      canDetach,
      presentation,
      row,
      t,
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
  providerNative,
}: {
  inline?: boolean;
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
  providerNative: boolean;
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
        accessibilityLabel={
          providerNative
            ? t("subagents.dismissAction", { label: displayLabel })
            : t("subagents.archiveAction", { label: displayLabel })
        }
        testID={`subagents-track-archive-${rowId}`}
        tooltipLabel={
          providerNative ? t("subagents.dismissTooltip") : t("subagents.archiveTooltip")
        }
        inline={inline}
        icon={providerNative ? "dismiss" : "archive"}
        visible={visible}
        onPress={onArchivePress}
      />
    </View>
  );
}

type SubagentActionIcon = "archive" | "detach" | "dismiss";

function renderSubagentActionIcon(
  icon: SubagentActionIcon,
  isActive: boolean,
  size: number,
): ReactElement {
  const uniProps = isActive ? foregroundColorMapping : foregroundMutedColorMapping;
  if (icon === "dismiss") return <ThemedX size={size} uniProps={uniProps} />;
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
  rowMetadata: { maxWidth: "50%", textAlign: "right" },
  groups: { gap: theme.spacing[3] },
  cardRows: {
    marginLeft: { xs: theme.spacing[1], md: theme.spacing[2] },
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
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionClusterVisible: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexShrink: 0,
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

const HEADING_ICON = <TaskCardIcon kind="subagents" />;
