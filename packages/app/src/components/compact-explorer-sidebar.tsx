import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, Text } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatPrTabLabel } from "@/git/pull-request-panel";
import {
  usePanelStore,
  selectIsCompactFileExplorerOpen,
  type ExplorerTab,
} from "@/stores/panel-store";
import { useCloseFileExplorerGesture } from "@/mobile-panels/gestures";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { ChangesSurface } from "@/git/diff-pane";
import { changesStateSchema, defaultChangesState, type ChangesState } from "@/panels/changes/state";
import { FileExplorerPane } from "./file-explorer-pane";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { shouldUseCompactExplorerKeyboardPadding } from "@/keyboard/shift";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { RetainedPanel, RetainedPanelActivity } from "@/components/retained-panel";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import { usePullRequestPanelAvailability } from "@/panels/pull-request-availability";
import { PullRequestContent } from "@/panels/pull-request";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import {
  explorerSidebarCloseButtonLayout,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { CardColumn } from "@/agent-stream/columns/card-column";
import { PortalHost } from "@gorhom/portal";
import { floatingPanelStyles, FLOATING_PANEL_INSET } from "@/styles/floating-panel";

const ThemedX = withUnistyles(X);

function logExplorerSidebar(_event: string, _details: Record<string, unknown>): void {}

interface ExplorerSidebarProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  onOpenFile?: (filePath: string) => void;
}

interface ExplorerSidebarSharedState {
  explorerTab: ExplorerTab;
  handleTabPress: (tab: ExplorerTab) => void;
}

function useExplorerSidebarSharedState({
  serverId,
  workspaceRoot,
  isGit,
}: Pick<ExplorerSidebarProps, "serverId" | "workspaceRoot" | "isGit">): ExplorerSidebarSharedState {
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const handleTabPress = useCallback(
    (tab: ExplorerTab) => {
      setExplorerTabForCheckout({ serverId, cwd: workspaceRoot, isGit, tab });
    },
    [isGit, serverId, setExplorerTabForCheckout, workspaceRoot],
  );

  return { explorerTab, handleTabPress };
}

export function CompactExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
}: ExplorerSidebarProps) {
  const insets = useSafeAreaInsets();
  const isActive = useIsMobilePanelActive("file-explorer");
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const usePanelKeyboardPadding = shouldUseCompactExplorerKeyboardPadding({ isGit, explorerTab });
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: usePanelKeyboardPadding,
  });
  const { gesture: closeGesture } = useCloseFileExplorerGesture();

  const handleClose = useCallback(
    (reason: string) => {
      logExplorerSidebar("handleClose", {
        reason,
        isOpen: isActive,
      });
      showMobileAgent();
    },
    [isActive, showMobileAgent],
  );

  const handleHeaderClose = useCallback(() => handleClose("header-close-button"), [handleClose]);

  const mobileSidebarStyle = useMemo(
    () => [
      {
        paddingTop: insets.top + HEADER_TOP_PADDING_MOBILE,
        paddingBottom: usePanelKeyboardPadding ? 0 : insets.bottom,
      },
      mobileKeyboardInsetStyle,
    ],
    [insets.bottom, insets.top, mobileKeyboardInsetStyle, usePanelKeyboardPadding],
  );

  return (
    <RetainedPanelActivity active={isActive}>
      <MobilePanelOverlay
        panel="file-explorer"
        closeGesture={closeGesture}
        panelStyle={mobileSidebarStyle}
      >
        <ExplorerSidebarContent
          activeTab={explorerTab}
          onTabPress={handleTabPress}
          onClose={handleHeaderClose}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          isGit={isGit}
          isOpen={isActive}
          onOpenFile={onOpenFile}
        />
      </MobilePanelOverlay>
    </RetainedPanelActivity>
  );
}

interface NativeExplorerSidebarDockProps extends ExplorerSidebarProps {
  cardHostName?: string;
  persistenceKey: string;
  containerWidth: number;
}

export function NativeExplorerSidebarDock({
  cardHostName,
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
  persistenceKey,
  containerWidth,
}: NativeExplorerSidebarDockProps) {
  const insets = useSafeAreaInsets();
  const isOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const storedWidth = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarWidthByWorkspace[persistenceKey],
  );
  const resizeExplorerSidebar = useWorkspaceLayoutStore((state) => state.resizeExplorerSidebar);
  const visibleWidth = resolveExplorerSidebarWidth({
    requestedWidth: storedWidth,
    containerWidth,
  });
  const resizeWidth = useSharedValue(visibleWidth);
  const startWidthRef = useRef(visibleWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });

  useEffect(() => {
    resizeWidth.value = visibleWidth;
  }, [resizeWidth, visibleWidth]);

  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);
  const commitWidth = useCallback(
    (width: number) => resizeExplorerSidebar(persistenceKey, width),
    [persistenceKey, resizeExplorerSidebar],
  );
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => scheduleOnRN(showResizeGrip))
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleWidth + event.translationX;
          resizeWidth.value = visibleWidth;
        })
        .onUpdate((event) => {
          resizeWidth.value = resolveExplorerSidebarWidth({
            requestedWidth: startWidthRef.current - event.translationX,
            containerWidth,
          });
        })
        .onEnd(() => runOnJS(commitWidth)(resizeWidth.value))
        .onFinalize(() => scheduleOnRN(hideResizeGrip)),
    [commitWidth, containerWidth, hideResizeGrip, resizeWidth, showResizeGrip, visibleWidth],
  );
  const animatedWidthStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));
  const dockStyle = useMemo(
    () => [
      styles.nativeDock,
      {
        display: isOpen ? ("flex" as const) : ("none" as const),
        paddingTop: insets.top + HEADER_TOP_PADDING_MOBILE,
      },
      animatedWidthStyle,
    ],
    [animatedWidthStyle, insets.top, isOpen],
  );

  return (
    <RetainedPanelActivity active={isOpen}>
      <Animated.View style={dockStyle} testID="native-explorer-sidebar-dock">
        <View style={styles.nativeDockContent}>
          <SidebarResizeHandle
            edge="left"
            gesture={resizeGesture}
            pressed={resizePressed}
            testID="native-explorer-sidebar-resize-handle"
          />
          <ExplorerSidebarContent
            cardHostName={cardHostName}
            activeTab={explorerTab}
            onTabPress={handleTabPress}
            onClose={showMobileAgent}
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={workspaceRoot}
            isGit={isGit}
            isOpen={isOpen}
            onOpenFile={onOpenFile}
          />
        </View>
      </Animated.View>
    </RetainedPanelActivity>
  );
}

interface SidebarContentProps {
  cardHostName?: string;
  activeTab: ExplorerTab;
  onTabPress: (tab: ExplorerTab) => void;
  onClose: () => void;
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  isOpen: boolean;
  onOpenFile?: (filePath: string) => void;
}

function ExplorerSidebarContent({
  cardHostName,
  activeTab,
  onTabPress,
  onClose,
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  isOpen,
  onOpenFile,
}: SidebarContentProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const closeButtonLayout = explorerSidebarCloseButtonLayout(isCompact);
  const closeButtonStyle = useMemo(
    () => ({ width: closeButtonLayout.size, height: closeButtonLayout.size }),
    [closeButtonLayout.size],
  );
  // The close glyph shares the trailing rail with the toolbar rows below it.
  const headerRightSectionStyle = useMemo(
    () => [styles.headerRightSection, { paddingRight: closeButtonLayout.trailingPadding }],
    [closeButtonLayout.trailingPadding],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<ExplorerTab>>(() => new Set([activeTab]));
  const { prPane, showPullRequest: showPrTab } = usePullRequestPanelAvailability({
    serverId,
    cwd: workspaceRoot,
    isGit,
    requested: activeTab === "pr" || expanded.has("pr"),
    enabled: isOpen,
    timelineEnabled: isOpen && expanded.has("pr"),
  });
  const requestedTab: ExplorerTab =
    !isGit && (activeTab === "changes" || activeTab === "pr") ? "files" : activeTab;
  const resolvedTab: ExplorerTab = requestedTab === "pr" && !showPrTab ? "changes" : requestedTab;
  const prTabLabel = formatPrTabLabel(prPane.prNumber);
  const availableTabs = useMemo<ExplorerTab[]>(() => {
    const tabs: ExplorerTab[] = isGit ? ["changes", "files"] : ["files"];
    if (isGit && showPrTab) tabs.push("pr");
    return tabs;
  }, [isGit, showPrTab]);
  const { mountedTabIds } = useMountedTabSet({
    activeTabId: resolvedTab,
    allTabIds: availableTabs,
    cap: availableTabs.length,
  });

  useEffect(() => {
    if (isOpen)
      setExpanded((previous) =>
        previous.has(resolvedTab) ? previous : new Set([...previous, resolvedTab]),
      );
  }, [isOpen, resolvedTab]);
  const toggleCard = useCallback(
    (tab: ExplorerTab) => {
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(tab)) next.delete(tab);
        else next.add(tab);
        return next;
      });
      if (!expanded.has(tab)) onTabPress(tab);
    },
    [expanded, onTabPress],
  );

  return (
    <View style={[floatingPanelStyles.surface, styles.sidebarContent]} pointerEvents="auto">
      <WindowChromeSafeArea placement="inline" style={styles.header} testID="explorer-header">
        <TitlebarDragRegion />
        <Text style={styles.headerTitle}>Workspace views</Text>
        <View style={headerRightSectionStyle}>
          <ToolbarButton
            compact={isCompact}
            style={closeButtonStyle}
            hitSlop={closeButtonLayout.hitSlop}
            label={t("workspace.tabs.explorerSidebar.close")}
            onPress={onClose}
            testID="explorer-close"
            nativeID="explorer-close"
          >
            <ThemedX size={closeButtonLayout.iconSize} uniProps={mutedIconColorMapping} />
          </ToolbarButton>
        </View>
      </WindowChromeSafeArea>
      <View style={styles.contentArea} testID="explorer-content-area">
        <CardColumn>
          {cardHostName ? <PortalHost name={cardHostName} /> : null}
          <ExplorerViewCard
            tab="files"
            label={t("workspace.tabs.explorerSidebar.files")}
            expanded={expanded.has("files")}
            onToggle={toggleCard}
          >
            {mountedTabIds.has("files") ? (
              <FilesPane
                serverId={serverId}
                workspaceId={workspaceId}
                workspaceRoot={workspaceRoot}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </ExplorerViewCard>
          {isGit ? (
            <ExplorerViewCard
              tab="changes"
              label={t("workspace.tabs.explorerSidebar.changes")}
              expanded={expanded.has("changes")}
              onToggle={toggleCard}
            >
              {mountedTabIds.has("changes") ? (
                <ChangedFilesPane
                  serverId={serverId}
                  workspaceId={workspaceId}
                  workspaceRoot={workspaceRoot}
                  isOpen={isOpen && expanded.has("changes")}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </ExplorerViewCard>
          ) : null}
          {isGit && showPrTab ? (
            <ExplorerViewCard
              tab="pr"
              label={prTabLabel}
              expanded={expanded.has("pr")}
              onToggle={toggleCard}
            >
              {mountedTabIds.has("pr") ? (
                <PrTabContent
                  serverId={serverId}
                  workspaceId={workspaceId}
                  cwd={workspaceRoot}
                  prPane={prPane}
                />
              ) : null}
            </ExplorerViewCard>
          ) : null}
          {cardHostName ? <PortalHost name={`${cardHostName}:queue`} /> : null}
        </CardColumn>
      </View>
    </View>
  );
}

function ExplorerViewCard({
  tab,
  label,
  expanded,
  onToggle,
  children,
}: {
  tab: ExplorerTab;
  label: string;
  expanded: boolean;
  onToggle: (tab: ExplorerTab) => void;
  children: ReactNode;
}) {
  const toggle = useCallback(() => onToggle(tab), [onToggle, tab]);
  const icon = useMemo(() => <TaskCardIcon kind={tab === "files" ? "files" : "changes"} />, [tab]);
  return (
    <TaskCard panelHeight={360} bodyVisible={expanded} testID={`compact-supporting-card-${tab}`}>
      <TaskCardHeader>
        <CardDisclosure
          title={label}
          expanded={expanded}
          onPress={toggle}
          testID={`explorer-tab-${tab}`}
          icon={icon}
        />
      </TaskCardHeader>
      <RetainedPanel active={expanded}>{children}</RetainedPanel>
    </TaskCard>
  );
}

function ChangedFilesPane({
  serverId,
  workspaceId,
  workspaceRoot,
  isOpen,
  onOpenFile,
}: Pick<
  SidebarContentProps,
  "serverId" | "workspaceId" | "workspaceRoot" | "isOpen" | "onOpenFile"
>) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  const [changesState, setChangesState] = useState<ChangesState>(() =>
    changesStateSchema.parse(defaultChangesState),
  );
  return (
    <ChangesSurface
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={workspaceRoot}
      enabled={isOpen}
      onOpenFile={onOpenFile}
      onAddToChat={canAddToChat ? addFile : undefined}
      state={changesState}
      onStateChange={setChangesState}
    />
  );
}

function FilesPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
}: Pick<SidebarContentProps, "serverId" | "workspaceId" | "workspaceRoot" | "onOpenFile">) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  return (
    <FileExplorerPane
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      onOpenFile={onOpenFile}
      onAddToChat={canAddToChat ? addFile : undefined}
    />
  );
}

const PrTabContent = PullRequestContent;

const styles = StyleSheet.create((theme) => ({
  nativeDock: {
    position: "relative",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  nativeDockContent: {
    position: "relative",
    flex: 1,
    minHeight: 0,
  },
  sidebarContent: {
    margin: FLOATING_PANEL_INSET,
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    paddingHorizontal: 12,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.display,
    fontSize: theme.fontSize.base,
  },
  headerRightSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  contentArea: {
    padding: FLOATING_PANEL_INSET,
    flex: 1,
    minHeight: 0,
  },
}));
