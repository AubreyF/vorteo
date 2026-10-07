import { TrailingActionScrim } from "@/components/ui/trailing-action-scrim";
import { WorkspaceLifecycleIndicators } from "@/workspace/lifecycle/indicators";
import {
  ExecutionEnvironmentIcon,
  useHasExecutionEnvironment,
} from "@/execution-installation/environment-icon";
import { WorkspaceGoalBadge } from "@/goals/workspace-goal-badge";
import { WorkspaceQueueCount } from "@/message-queue/workspace-queue-count";
import { WorkspaceSubagentCount } from "@/subagents/workspace-count";
import { useVortonTouch } from "@/vorton-touch";

import { useSidebarActionSize } from "./use-sidebar-action-size";
import { memo, useMemo, useCallback, useState, type ReactNode } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert, Folder, FolderGit2, Monitor } from "lucide-react-native";
import { ProjectStatusIndicator } from "@/components/sidebar/project-leading-visual";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import {
  WorkspaceMetaRow,
  ServiceItem,
  selectWorkspaceServiceSummary,
  type WorkspaceServiceSummary,
} from "@/components/sidebar/workspace-meta-row";
import { WorkspaceHoverCard } from "@/components/workspace-hover-card";
import type { HostBadgeModel } from "@/hosts/appearance";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  hasSidebarWorkspaceTrailing,
  type SidebarWorkspaceTrailing,
} from "@/components/sidebar/workspace-trailing";
import { useAppSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import {
  STATUS_INDICATOR_ALERT_SIZE,
  STATUS_INDICATOR_DOT_SIZE,
  STATUS_INDICATOR_FILLED_DOT_SIZE,
} from "@/utils/status-indicator-geometry";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { StatusRing } from "@/components/status-ring";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { WorkspaceLabelChip } from "@/workspace-labels/chip";
import { useWorkspaceLabelDefinitions } from "@/workspace-labels";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const needsInputColorMapping = (theme: Theme) => ({
  color: theme.colors.surface0,
  fill: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});

const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderGit2 = withUnistyles(FolderGit2);

export function SidebarWorkspaceRowFrame({
  workspace,
  isDragging = false,
  children,
}: {
  workspace: SidebarWorkspaceEntry;
  isDragging?: boolean;
  children: (input: {
    isHovered: boolean;
    contextMenuOpen: boolean;
    onContextMenuOpenChange: (open: boolean) => void;
    hoverHandlers: { onPointerEnter: () => void; onPointerLeave: () => void };
  }) => ReactNode;
}) {
  const touch = useVortonTouch();
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const handlePointerEnter = useCallback(() => {
    if (!contextMenuOpen && !touch) setIsHovered(true);
  }, [contextMenuOpen, touch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
  const hoverHandlers = useMemo(
    () => ({ onPointerEnter: handlePointerEnter, onPointerLeave: handlePointerLeave }),
    [handlePointerEnter, handlePointerLeave],
  );

  return (
    <WorkspaceHoverCard
      workspace={workspace}
      prHint={workspace.prHint}
      isDragging={isDragging}
      disabled={contextMenuOpen}
    >
      {children({
        isHovered: isHovered && !contextMenuOpen && !isDragging && !touch,
        contextMenuOpen,
        onContextMenuOpenChange: handleContextMenuOpenChange,
        hoverHandlers,
      })}
    </WorkspaceHoverCard>
  );
}

function WorkspaceActivityBadges({
  serverId,
  workspaceId,
  visible,
}: {
  serverId: string;
  workspaceId: string;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <>
      <WorkspaceQueueCount serverId={serverId} workspaceId={workspaceId} />
      <WorkspaceSubagentCount serverId={serverId} workspaceId={workspaceId} />
      <WorkspaceGoalBadge serverId={serverId} workspaceId={workspaceId} />
    </>
  );
}

function visibleHostBadge(installedEnvironment: boolean, badge: HostBadgeModel | null | undefined) {
  return installedEnvironment ? null : (badge ?? null);
}

export const SidebarWorkspaceRowContent = memo(function SidebarWorkspaceRowContent({
  workspace,
  hostBadge,
  leadingProjectName = null,
  leadingProjectIconDataUri = null,
  backdrop,
  isHovered,
  isLoading,
  isCreating = false,
  shortcutNumber = null,
  showShortcutBadge = false,
  reserveIdleStatusIndicatorSpace = true,
  children,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge?: HostBadgeModel | null;
  /** Hoisted rows use their project icon as the leading visual because no project row contains them. */
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  serviceSummary?: WorkspaceServiceSummary | null;
  /** The row's current background, so the project status badge can knock out of it. */
  backdrop: SidebarSurfaceBackdrop;
  isHovered: boolean;
  isLoading: boolean;
  isCreating?: boolean;
  shortcutNumber?: number | null;
  showShortcutBadge?: boolean;
  /** Keep the empty leading slot when the workspace has no active status. */
  reserveIdleStatusIndicatorSpace?: boolean;
  children?: ReactNode;
}) {
  const {
    settings: { workspaceTitleSource },
  } = useAppSettings();
  const workspaceLabel = resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource });

  const installedEnvironment = useHasExecutionEnvironment(workspace.serverId);
  const workspaceBranchTextStyle = useMemo(
    () => [
      styles.workspaceBranchText,
      isHovered && styles.workspaceBranchTextHovered,
      isCreating && styles.workspaceBranchTextCreating,
    ],
    [isHovered, isCreating],
  );

  return (
    <View style={styles.workspaceRowContent}>
      <View style={[styles.workspaceRowMain, styles.alignedRow]}>
        {leadingProjectName ? (
          <ProjectStatusIndicator
            iconDataUri={leadingProjectIconDataUri}
            displayName={leadingProjectName}
            projectViewKey={workspace.projectViewKey}
            statusBucket={workspace.statusBucket}
            backdrop={backdrop}
            loading={isLoading}
            testID={`sidebar-row-project-icon-${workspace.workspaceKey}`}
          />
        ) : (
          <WorkspaceStatusIndicator
            bucket={workspace.statusBucket}
            workspaceKind={workspace.workspaceKind}
            loading={isLoading}
            reserveIdleSpace={reserveIdleStatusIndicatorSpace}
          />
        )}
        <View style={styles.workspaceContentColumn}>
          <View style={[styles.workspaceTitleRow, styles.alignedRow]}>
            <ExecutionEnvironmentIcon serverId={workspace.serverId} hostOnly />
            <Text style={workspaceBranchTextStyle} numberOfLines={1}>
              {workspaceLabel}
            </Text>
            <View style={[sidebarWorkspaceRowStyles.rowRight, styles.alignedActions]}>
              {children}
            </View>
          </View>
          <WorkspaceMetaRow
            currentBranch={workspace.currentBranch}
            projectName={leadingProjectName}
            hostBadge={visibleHostBadge(installedEnvironment, hostBadge)}
            prHint={workspace.prHint}
            serviceSummary={null}
          />
        </View>
      </View>
      {showShortcutBadge && shortcutNumber !== null ? (
        <View style={styles.shortcutBadgeOverlay} pointerEvents="none">
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        </View>
      ) : null}
    </View>
  );
});

function WorkspaceStatusIndicator({
  bucket,
  workspaceKind,
  loading = false,
  reserveIdleSpace = true,
}: {
  bucket: SidebarWorkspaceEntry["statusBucket"];
  workspaceKind: SidebarWorkspaceEntry["workspaceKind"];
  loading?: boolean;
  reserveIdleSpace?: boolean;
}) {
  // Busy is the only status that moves, and it is the ring rather than a dot for the same
  // reason it is a dot elsewhere: every status in the sidebar sits in this one slot, so busy
  // has to fill it without displacing anything. A row starting up and a row working are both
  // busy, so they share the ring and differ only in testID.
  if (loading) {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-loading">
        <StatusRing />
      </View>
    );
  }

  if (shouldRenderSyncedStatusLoader({ bucket })) {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-running">
        <StatusRing />
      </View>
    );
  }

  if (bucket === "needs_input") {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-needs_input">
        <ThemedCircleAlert size={STATUS_INDICATOR_ALERT_SIZE} uniProps={needsInputColorMapping} />
      </View>
    );
  }

  if (bucket === "attention") {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-attention">
        <View style={styles.standaloneStatusDot} />
      </View>
    );
  }

  if (bucket === "done") {
    // An idle row still gets a dot rather than an empty slot. Nested rows are marked as
    // workspaces by indentation alone, and with nothing in the leading slot the rail has no
    // edge to read against — a workspace carrying its own glyph starts looking like a project
    // header. The dot is muted to half opacity so it holds the rail without reporting status.
    return reserveIdleSpace ? (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-done">
        <View style={styles.idleStatusDot} />
      </View>
    ) : null;
  }

  let KindIcon: typeof ThemedMonitor;
  if (workspaceKind === "local_checkout") KindIcon = ThemedMonitor;
  else if (workspaceKind === "worktree") KindIcon = ThemedFolderGit2;
  else KindIcon = ThemedFolder;

  const dotColorStyle = getStatusDotColorStyle(bucket);
  return (
    <View style={styles.workspaceStatusDot} testID={`workspace-status-indicator-${bucket}`}>
      <KindIcon size={14} uniProps={foregroundMutedColorMapping} />
      {dotColorStyle ? <StatusDotOverlay dotColorStyle={dotColorStyle} /> : null}
    </View>
  );
}

function StatusDotOverlay({ dotColorStyle }: { dotColorStyle: ViewStyle }) {
  return <View style={[styles.statusDotOverlay, dotColorStyle]} />;
}

function getStatusDotColorStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.statusDotNeedsInput;
    case "failed":
      return styles.statusDotFailed;
    case "running":
      return styles.statusDotRunning;
    case "attention":
      return styles.statusDotAttention;
    case "done":
      return null;
  }
}

export const sidebarWorkspaceRowStyles = StyleSheet.create((theme) => ({
  // How far a workspace row sits inside the group header above it — a project row or a
  // status group header. Both groupings share this one indent, so every grouped workspace row
  // in the sidebar sits on the same rail regardless of how the list is grouped. Pinned rows
  // are not grouped and stay flush.
  //
  // It is row padding rather than a margin on the list, because the row's hover and selected
  // backgrounds have to keep spanning the group's full width. Indenting the container instead
  // pulls the highlight in with the content and the row stops lining up with its header.
  rowIndented: {
    paddingLeft: theme.spacing[2] + theme.spacing[2],
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  shortcutBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  shortcutBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 14,
  },
  hidden: { opacity: 0 },
}));

export function SidebarWorkspaceShortcutBadge({ number }: { number: number }) {
  return (
    <View style={sidebarWorkspaceRowStyles.shortcutBadge}>
      <Text style={sidebarWorkspaceRowStyles.shortcutBadgeText}>{number}</Text>
    </View>
  );
}

export type SidebarWorkspaceTrailingPresentation = "visible" | "hidden" | "absent";

/** Shared visibility for project and status grouping. The menu reserves space only when shown. */
export function resolveTrailingActionVisibility({
  workspace,
  trailing,
  hasArchiveAction,
  isHovered,
  isTouchPlatform,
  showShortcut,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
  hasArchiveAction: boolean;
  isHovered: boolean;
  isTouchPlatform: boolean;
  showShortcut: boolean;
}): {
  trailingPresentation: SidebarWorkspaceTrailingPresentation;
  showKebab: boolean;
  renderSlot: boolean;
} {
  const hasTrailing = hasSidebarWorkspaceTrailing({ workspace, trailing });
  const showKebab = Boolean(hasArchiveAction && (isHovered || isTouchPlatform)) && !showShortcut;
  const hasContent = hasTrailing;
  let trailingPresentation: SidebarWorkspaceTrailingPresentation = "absent";
  if (hasContent) trailingPresentation = showShortcut ? "hidden" : "visible";
  return {
    trailingPresentation,
    showKebab,
    renderSlot: true,
  };
}

export function SidebarWorkspaceTrailingActionSlot({ children }: { children: ReactNode }) {
  return <View style={styles.trailingRail}>{children}</View>;
}

export function SidebarWorkspaceTrailingDetails({
  workspace,
}: {
  workspace: SidebarWorkspaceEntry;
}) {
  const {
    settings: { sidebarRowItems },
  } = useAppSettings();
  const service = selectWorkspaceServiceSummary(workspace.scripts);
  const labels = useWorkspaceLabelDefinitions(workspace.serverId, workspace.labels);
  return (
    <View style={styles.trailingDetails}>
      {service ? <ServiceItem summary={service} iconOnly /> : null}
      <WorkspaceActivityBadges
        serverId={workspace.serverId}
        workspaceId={workspace.workspaceId}
        visible={sidebarRowItems.activityBadges}
      />
      {sidebarRowItems.labels && labels.length > 0 ? (
        <View style={styles.customLabels}>
          {labels.map((label) => (
            <WorkspaceLabelChip key={label.name} label={label} />
          ))}
        </View>
      ) : null}
      <WorkspaceLifecycleIndicators workspace={workspace} />
    </View>
  );
}

export function SidebarWorkspaceTrailingActionBase({
  presentation,
  children,
}: {
  presentation: SidebarWorkspaceTrailingPresentation;
  children: ReactNode;
}) {
  if (presentation === "absent") return null;
  return (
    <View style={presentation === "hidden" ? sidebarWorkspaceRowStyles.hidden : undefined}>
      {children}
    </View>
  );
}

export function SidebarWorkspaceMenuReveal({
  visible,
  backdrop,
  children,
}: {
  visible: boolean;
  backdrop: SidebarSurfaceBackdrop;
  children: ReactNode;
}) {
  const actionSize = useSidebarActionSize();
  const touch = useVortonTouch();
  // Overlay the trailing content without changing the row's layout.
  return (
    <>
      {touch ? <View pointerEvents="none" style={[styles.touchMenuSpace, actionSize]} /> : null}
      {visible ? (
        <View
          testID="sidebar-menu-backdrop"
          style={[styles.menuEdge, styles.menuBackdrop(backdrop), actionSize]}
        >
          {!touch ? <TrailingActionScrim backdrop={backdrop} testID="sidebar-menu-fade" /> : null}
          {children}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trailingRail: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
  },
  trailingDetails: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  // Custom names yield before the built-in state badges in a crowded row.
  customLabels: {
    flexDirection: "row",
    gap: theme.spacing[1],
    flexShrink: 1000,
    minWidth: 0,
    overflow: "hidden",
  },
  menuBackdrop: (backdrop: SidebarSurfaceBackdrop) => ({ backgroundColor: theme.colors[backdrop] }),
  touchMenuSpace: { flexShrink: 0, marginLeft: 4 },
  menuEdge: {
    position: "absolute",
    right: 0,
    alignItems: "flex-end",
    justifyContent: "center",
    borderRadius: 0,
  },
  alignedRow: { alignItems: "center" },
  alignedActions: { alignItems: "center", gap: 4 },
  serviceSlot: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  workspaceRowContent: {
    position: "relative",
  },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    width: "100%",
  },
  workspaceContentColumn: {
    flex: 1,
    minWidth: 0,
  },
  workspaceTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  shortcutBadgeOverlay: {
    position: "absolute",
    top: 1,
    right: 0,
  },
  workspaceStatusDot: {
    position: "relative",
    width: theme.iconSize.md,
    height: 20,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDotOverlay: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: STATUS_INDICATOR_DOT_SIZE,
    height: STATUS_INDICATOR_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  standaloneStatusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  idleStatusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.3,
  },
  workspaceBranchText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
    flex: 1,
    minWidth: theme.spacing[12],
  },
  workspaceBranchTextCreating: {
    opacity: 0.92,
  },
  workspaceBranchTextHovered: {
    opacity: 1,
  },
  statusDotNeedsInput: {
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
  statusDotFailed: {
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
  statusDotRunning: {
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
  statusDotAttention: {
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
}));
