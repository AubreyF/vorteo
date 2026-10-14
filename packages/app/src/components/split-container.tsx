import { PortalHost } from "@gorhom/portal";
import { SharedWorkspaceToolbarContext } from "@/screens/workspace/shared-toolbar-context";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useWorkspaceShellMeasurement } from "@/hooks/use-responsive-sidebar";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { View, Text, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
import {
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";
import { RetainedPanel } from "@/components/retained-panel";
import { hasMultipleVisiblePanes, splitNodeContainsPane } from "@/components/split-container-panes";
import { shouldFocusPaneFromEventTarget } from "@/components/split-container-pane-focus";
import {
  removeWindowChromeCorner,
  WindowChromeRegion,
  WindowChromeSafeArea,
  useWindowChromeCorners,
  type WindowChromeCorners,
} from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import {
  computeTabDropPreview,
  type TabDropPreview,
} from "@/components/split-container-tab-drop-preview";
import {
  SplitDropZone,
  resolveSplitDropPosition,
  type SplitDropZoneHover,
} from "@/components/split-drop-zone";
import {
  deriveWorkspacePaneState,
  getWorkspacePaneDescriptors,
} from "@/screens/workspace/workspace-pane-state";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import { WorkspacePanelHost } from "@/screens/workspace/workspace-panel-host";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import { SupportingViewCards } from "@/screens/workspace/supporting-view-cards";
import { SupportingCardsContext } from "@/screens/workspace/supporting-cards-context";
import { COLUMN_BREAKPOINT } from "@/agent-stream/columns/geometry";
import { SupportingCardGroup } from "@/screens/workspace/supporting-card-group";
import { FLOATING_PANEL_INSET } from "@/styles/floating-panel";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  createDefaultLayout,
  findPaneById,
  useWorkspaceLayoutStore,
  type SplitNode,
  type SplitPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { RenderProfile } from "@/utils/render-profiler";
import { isNative } from "@/constants/platform";
import { panelTargetSupportsHost } from "@/plugins/workspace-panels/locations";

interface SplitContainerProps {
  layout: WorkspaceLayout;
  supportingCardsCollapsed?: boolean;
  onSupportingCardsVisibilityChange?: (visible: boolean) => void;
  renderMainHeader?: () => ReactNode;
  renderExplorerSidebarHeaderAction?: (visible: boolean) => ReactNode;
  workspaceKey: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  uiTabs: WorkspaceTab[];
  hoveredCloseTabKey: string | null;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  closingTabIds: Set<string>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCreateNewTab: (input: { paneId?: string }) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
  onFocusPane: (paneId: string) => void;
  onSplitPane: (input: {
    tabId: string;
    targetPaneId: string;
    position: "left" | "right" | "top" | "bottom";
  }) => void;
  onSplitPaneEmpty: (input: {
    targetPaneId: string;
    position: "left" | "right" | "top" | "bottom";
  }) => void;
  onMoveTabToPane: (tabId: string, toPaneId: string) => void;
  onSelectTabInPane: (paneId: string, tabId: string) => void;
  onResizeSplit: (groupId: string, sizes: number[]) => void;
  onReorderTabsInPane: (paneId: string, tabIds: string[]) => void;
}

interface WorkspaceTabDragData {
  kind: "workspace-tab";
  paneId: string;
  tabId: string;
}

interface SplitPaneDropData {
  kind: "split-pane-drop";
  paneId: string;
}

const EMPTY_SPLIT_NODES: SplitNode[] = [];
const EMPTY_SPLIT_SIZES: number[] = [];
const EXPLORER_SIDEBAR_RESIZE_GROUP_ID = "explorer-sidebar";

function isWorkspaceTabDragData(data: unknown): data is WorkspaceTabDragData {
  return typeof data === "object" && data !== null && Reflect.get(data, "kind") === "workspace-tab";
}

function isSplitPaneDropData(data: unknown): data is SplitPaneDropData {
  return (
    typeof data === "object" && data !== null && Reflect.get(data, "kind") === "split-pane-drop"
  );
}

function asWorkspaceTabDragData(data: unknown): WorkspaceTabDragData | undefined {
  return isWorkspaceTabDragData(data) ? data : undefined;
}

function asDragOverData(data: unknown): WorkspaceTabDragData | SplitPaneDropData | undefined {
  if (isWorkspaceTabDragData(data)) return data;
  if (isSplitPaneDropData(data)) return data;
  return undefined;
}

interface SplitNodeViewProps extends Omit<
  SplitContainerProps,
  "layout" | "onMoveTabToPane" | "onSelectTabInPane"
> {
  node: SplitNode;
  uiTabs: WorkspaceTab[];
  focusedPaneId: string | null;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
  windowChromeCorners: WindowChromeCorners;
  maximizedPaneId: string | null;
  workspaceHasMultiplePanes: boolean;
  onTogglePaneMaximized: (paneId: string) => void;
}

interface SplitPaneViewProps extends Omit<
  SplitNodeViewProps,
  | "node"
  | "workspaceKey"
  | "focusedPaneId"
  | "activeDragTabId"
  | "showDropZones"
  | "dropPreview"
  | "onResizeSplit"
  | "windowChromeCorners"
> {
  pane: SplitPane;
  uiTabs: WorkspaceTab[];
  isFocused: boolean;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
}

interface DragMoveRects {
  translatedRect: { left: number; top: number; width: number; height: number };
  overRect: { left: number; top: number; width: number; height: number };
}

function resolveDragMoveRects(
  event: Pick<DragMoveEvent, "active" | "over"> | Pick<DragOverEvent, "active" | "over">,
): DragMoveRects | null {
  const translatedRect = event.active.rect.current.translated;
  const overRect = event.over?.rect;
  if (!translatedRect || !overRect || overRect.width <= 0 || overRect.height <= 0) {
    return null;
  }
  return { translatedRect, overRect };
}

function computeTabOverDropPreview(input: {
  activeData: WorkspaceTabDragData;
  overData: WorkspaceTabDragData;
  rects: DragMoveRects;
  panesById: Map<string, SplitPane>;
  uiTabs: WorkspaceTab[];
}): TabDropPreview | null {
  const { activeData, overData, rects, panesById, uiTabs } = input;
  const targetPane = panesById.get(overData.paneId) ?? null;
  if (!targetPane) {
    return null;
  }
  const targetTabs = getWorkspacePaneDescriptors({
    pane: targetPane,
    tabs: uiTabs,
  });
  return computeTabDropPreview({
    activePaneId: activeData.paneId,
    activeTabId: activeData.tabId,
    overPaneId: overData.paneId,
    overTabId: overData.tabId,
    targetTabs,
    activeRect: {
      left: rects.translatedRect.left,
      width: rects.translatedRect.width,
    },
    overRect: {
      left: rects.overRect.left,
      width: rects.overRect.width,
    },
  });
}

function computePaneOverDropPreview(input: {
  overData: SplitPaneDropData;
  rects: DragMoveRects;
}): SplitDropZoneHover | null {
  const { overData, rects } = input;
  const centerX = rects.translatedRect.left + rects.translatedRect.width / 2;
  const centerY = rects.translatedRect.top + rects.translatedRect.height / 2;
  const relativeX = centerX - rects.overRect.left;
  const relativeY = centerY - rects.overRect.top;
  if (
    Number.isNaN(relativeX) ||
    Number.isNaN(relativeY) ||
    relativeX < 0 ||
    relativeX > rects.overRect.width ||
    relativeY < 0 ||
    relativeY > rects.overRect.height
  ) {
    return null;
  }
  return {
    paneId: overData.paneId,
    position: resolveSplitDropPosition({
      width: rects.overRect.width,
      height: rects.overRect.height,
      x: relativeX,
      y: relativeY,
    }),
  };
}

const dropCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const tabHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "workspace-tab",
  );
  if (tabHits.length > 0) {
    return tabHits;
  }

  const paneHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "split-pane-drop",
  );
  if (paneHits.length > 0) {
    return paneHits;
  }

  return closestCenter(args);
};

export function SplitContainer({
  layout,
  supportingCardsCollapsed,
  onSupportingCardsVisibilityChange,
  renderExplorerSidebarHeaderAction,
  renderMainHeader,
  workspaceKey,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  uiTabs,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateNewTab,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onMoveTabToPane,
  onSelectTabInPane,
  onResizeSplit,
  onReorderTabsInPane,
}: SplitContainerProps) {
  const inheritedWindowChromeCorners = useWindowChromeCorners();
  const windowChromeCorners = "none";
  const [activeDragTabId, setActiveDragTabId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<SplitDropZoneHover | null>(null);
  const [tabDropPreview, setTabDropPreview] = useState<TabDropPreview | null>(null);
  const [maximizedPane, setMaximizedPane] = useState<{
    workspaceKey: string;
    paneId: string;
  } | null>(null);
  const maximizedPaneId =
    maximizedPane?.workspaceKey === workspaceKey ? maximizedPane.paneId : null;
  const explorerSidebarPaneId = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null,
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const panesById = useMemo(() => collectPanesById(layout.root), [layout.root]);
  const explorerSidebarPane = useMemo(
    () => findPaneById(layout.root, explorerSidebarPaneId),
    [layout.root, explorerSidebarPaneId],
  );
  const mainRoot = useMemo(
    () => removePaneFromSplitTree(layout.root, explorerSidebarPaneId),
    [layout.root, explorerSidebarPaneId],
  );
  const workspaceHasMultiplePanes = Boolean(mainRoot && hasMultipleVisiblePanes(mainRoot));
  useEffect(() => {
    if (
      maximizedPaneId &&
      (!workspaceHasMultiplePanes || !mainRoot || !splitNodeContainsPane(mainRoot, maximizedPaneId))
    ) {
      setMaximizedPane(null);
    }
  }, [mainRoot, maximizedPaneId, workspaceHasMultiplePanes]);
  const handleTogglePaneMaximized = useCallback(
    (paneId: string) => {
      setMaximizedPane((current) =>
        current?.workspaceKey === workspaceKey && current.paneId === paneId
          ? null
          : { workspaceKey, paneId },
      );
    },
    [workspaceKey],
  );
  const renderedRoot = useMemo(() => mainRoot ?? createDefaultLayout().root, [mainRoot]);
  const storedExplorerSidebarWidth = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarWidthByWorkspace[workspaceKey],
  );
  const resizeExplorerSidebar = useWorkspaceLayoutStore((state) => state.resizeExplorerSidebar);
  const { workspaceShellWidth, handleWorkspaceShellLayout } = useWorkspaceShellMeasurement();
  const [previewExplorerSidebarWidth, setPreviewExplorerSidebarWidth] = useState<number | null>(
    null,
  );
  const requestedExplorerSidebarWidth = previewExplorerSidebarWidth ?? storedExplorerSidebarWidth;
  const explorerSidebarWidth = resolveExplorerSidebarWidth({
    requestedWidth: requestedExplorerSidebarWidth,
    containerWidth: workspaceShellWidth,
  });
  const explorerSidebarDockSizes = useMemo(
    () =>
      resolveExplorerSidebarDockSizes({
        requestedWidth: requestedExplorerSidebarWidth,
        containerWidth: workspaceShellWidth,
      }),
    [requestedExplorerSidebarWidth, workspaceShellWidth],
  );
  const supportingViewsVisible = Boolean(
    explorerSidebarPane && explorerSidebarPane.hidden !== true,
  );
  const focusedMainPane = mainRoot ? findPaneById(mainRoot, layout.focusedPaneId) : null;
  const focusedTarget = deriveWorkspacePaneState({
    pane: focusedMainPane,
    tabs: uiTabs,
  }).activeTab?.descriptor.target;
  const cardsAgentId = focusedTarget?.kind === "agent" ? focusedTarget.agentId : null;
  const cardHostName = `workspace-cards-${useId()}`;
  const renderExplorerSidebarDock = shouldShowSupportingCardGroup({
    collapsed: supportingCardsCollapsed,
    supportingViewsVisible,
    cardsAgentId,
    workspaceShellWidth,
  });
  useEffect(() => {
    onSupportingCardsVisibilityChange?.(renderExplorerSidebarDock);
  }, [onSupportingCardsVisibilityChange, renderExplorerSidebarDock]);
  const supportingCards = useMemo(
    () =>
      explorerSidebarPane ? (
        <SupportingViewCards
          pane={explorerSidebarPane}
          uiTabs={uiTabs}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          isWorkspaceFocused={isWorkspaceFocused}
          onSelectTab={onSelectTabInPane}
          buildPaneContentModel={buildPaneContentModel}
        />
      ) : null,
    [
      explorerSidebarPane,
      uiTabs,
      normalizedServerId,
      normalizedWorkspaceId,
      isWorkspaceFocused,
      onSelectTabInPane,
      buildPaneContentModel,
    ],
  );
  const supportingCardsValue = useMemo(
    () => ({
      agentId: cardsAgentId,
      // Desktop cards always belong to their dock, including while it is hidden
      // or awaiting its first layout event. Inline fallback is for compact hosts.
      hostName: cardHostName,
    }),
    [cardsAgentId, cardHostName],
  );
  const { toolbarMenuHost, toolbarContext, sharedToolbarStyle, measureToolbar } =
    useSharedToolbarGeometry(
      renderExplorerSidebarDock,
      explorerSidebarWidth,
      workspaceShellWidth,
      renderedRoot,
      maximizedPaneId,
    );
  const mainColumnWindowChromeCorners = renderExplorerSidebarDock
    ? removeWindowChromeCorner(inheritedWindowChromeCorners, "top-right")
    : inheritedWindowChromeCorners;
  const mainColumnStyle = styles.mainColumn;
  const explorerSidebarDockStyle = useMemo(
    () => [styles.explorerSidebarDock, { width: explorerSidebarWidth - FLOATING_PANEL_INSET * 2 }],
    [explorerSidebarWidth],
  );
  const previewExplorerSidebarResize = useCallback(
    (_groupId: string, sizes: number[]) => {
      const nextRatio = sizes[1];
      if (nextRatio !== undefined) {
        setPreviewExplorerSidebarWidth(
          resolveExplorerSidebarWidth({
            requestedWidth: nextRatio * workspaceShellWidth,
            containerWidth: workspaceShellWidth,
          }),
        );
      }
    },
    [workspaceShellWidth],
  );
  const commitExplorerSidebarResize = useCallback(
    (_groupId: string, sizes: number[]) => {
      setPreviewExplorerSidebarWidth(null);
      const nextRatio = sizes[1];
      if (nextRatio !== undefined) {
        resizeExplorerSidebar(
          workspaceKey,
          resolveExplorerSidebarWidth({
            requestedWidth: nextRatio * workspaceShellWidth,
            containerWidth: workspaceShellWidth,
          }),
        );
      }
    },
    [resizeExplorerSidebar, workspaceKey, workspaceShellWidth],
  );
  const renderRoot = useMemo(() => wrapRootPaneForStableMount(renderedRoot), [renderedRoot]);
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = asWorkspaceTabDragData(event.active.data.current);
    if (!data) {
      setActiveDragTabId(null);
      setDropPreview(null);
      setTabDropPreview(null);
      return;
    }
    setActiveDragTabId(data.tabId);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragTabId(null);
    setDropPreview(null);
    setTabDropPreview(null);
  }, []);

  const updateDropPreview = useCallback(
    (event: Pick<DragMoveEvent, "active" | "over"> | Pick<DragOverEvent, "active" | "over">) => {
      const activeData = asWorkspaceTabDragData(event.active.data.current);
      const overData = asDragOverData(event.over?.data.current);

      if (activeData?.kind !== "workspace-tab") {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      const rects = resolveDragMoveRects(event);
      if (!rects) {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      const activeTab = uiTabs.find((tab) => tab.tabId === activeData.tabId) ?? null;
      const destinationPaneId =
        overData?.kind === "workspace-tab" || overData?.kind === "split-pane-drop"
          ? overData.paneId
          : null;
      const destinationHost = destinationPaneId === explorerSidebarPaneId ? "explorer" : "main";
      if (
        !activeTab ||
        !panelTargetSupportsHost(normalizedServerId, activeTab.target, destinationHost)
      ) {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      if (overData?.kind === "workspace-tab") {
        const preview = computeTabOverDropPreview({
          activeData,
          overData,
          rects,
          panesById,
          uiTabs,
        });
        setDropPreview(null);
        setTabDropPreview(preview);
        return;
      }

      setTabDropPreview(null);
      if (overData?.kind !== "split-pane-drop") {
        setDropPreview(null);
        return;
      }

      setDropPreview(computePaneOverDropPreview({ overData, rects }));
    },
    [normalizedServerId, panesById, explorerSidebarPaneId, uiTabs],
  );

  const applyTabDropEnd = useCallback(
    (input: { activeData: WorkspaceTabDragData; overData: WorkspaceTabDragData }): void => {
      const { activeData, overData } = input;
      const sourcePane = panesById.get(activeData.paneId) ?? null;
      const targetPane = panesById.get(overData.paneId) ?? null;
      if (!sourcePane || !targetPane) {
        return;
      }

      const sourceTabs = getWorkspacePaneDescriptors({
        pane: sourcePane,
        tabs: uiTabs,
      });
      const targetTabs = getWorkspacePaneDescriptors({
        pane: targetPane,
        tabs: uiTabs,
      });
      const sourceIndex = sourceTabs.findIndex((tab) => tab.tabId === activeData.tabId);
      const resolvedTabDropPreview =
        tabDropPreview?.paneId === overData.paneId ? tabDropPreview : null;
      if (sourceIndex < 0 || !resolvedTabDropPreview) {
        return;
      }

      if (activeData.paneId === overData.paneId) {
        if (sourceIndex !== resolvedTabDropPreview.insertionIndex) {
          const nextTabs = arrayMove(
            sourceTabs,
            sourceIndex,
            resolvedTabDropPreview.insertionIndex,
          );
          onReorderTabsInPane(
            activeData.paneId,
            nextTabs.map((tab) => tab.tabId),
          );
        }
        return;
      }

      const nextTargetTabIds = targetTabs.map((tab) => tab.tabId);
      nextTargetTabIds.splice(resolvedTabDropPreview.insertionIndex, 0, activeData.tabId);
      onMoveTabToPane(activeData.tabId, overData.paneId);
      onReorderTabsInPane(overData.paneId, nextTargetTabIds);
    },
    [onMoveTabToPane, onReorderTabsInPane, panesById, tabDropPreview, uiTabs],
  );

  const applyPaneDropEnd = useCallback(
    (input: { activeData: WorkspaceTabDragData; overData: SplitPaneDropData }): void => {
      const { activeData, overData } = input;
      if (dropPreview?.paneId !== overData.paneId) {
        return;
      }
      if (dropPreview.position === "center") {
        if (activeData.paneId !== overData.paneId) {
          onMoveTabToPane(activeData.tabId, overData.paneId);
        }
        return;
      }
      onSplitPane({
        tabId: activeData.tabId,
        targetPaneId: overData.paneId,
        position: dropPreview.position,
      });
    },
    [dropPreview, onMoveTabToPane, onSplitPane],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = asWorkspaceTabDragData(event.active.data.current);
      const overData = asDragOverData(event.over?.data.current);

      setActiveDragTabId(null);

      if (activeData?.kind === "workspace-tab" && event.over) {
        if (overData?.kind === "workspace-tab") {
          applyTabDropEnd({ activeData, overData });
        } else if (overData?.kind === "split-pane-drop") {
          applyPaneDropEnd({ activeData, overData });
        }
      }

      setDropPreview(null);
      setTabDropPreview(null);
    },
    [applyTabDropEnd, applyPaneDropEnd],
  );

  const sidebarResizeHandle = useMemo(
    () =>
      renderExplorerSidebarDock ? (
        <ResizeHandle
          sidebar
          testID="workspace-explorer-sidebar-resize-handle"
          direction="horizontal"
          hitAreaAlignment="end"
          groupId={EXPLORER_SIDEBAR_RESIZE_GROUP_ID}
          index={0}
          sizes={explorerSidebarDockSizes}
          containerSize={workspaceShellWidth}
          onPreviewResizeSplit={previewExplorerSidebarResize}
          onResizeSplit={commitExplorerSidebarResize}
        />
      ) : null,
    [
      renderExplorerSidebarDock,
      explorerSidebarDockSizes,
      workspaceShellWidth,
      previewExplorerSidebarResize,
      commitExplorerSidebarResize,
    ],
  );

  return (
    <RenderProfile id="SplitContainer">
      <DndContext
        sensors={sensors}
        collisionDetection={dropCollisionDetection}
        onDragStart={handleDragStart}
        onDragMove={updateDropPreview}
        onDragOver={updateDropPreview}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <WorkspaceChromeProviders toolbar={toolbarContext} cards={supportingCardsValue}>
          <View style={styles.workspaceShell} onLayout={handleWorkspaceShellLayout}>
            <WindowChromeRegion corners={mainColumnWindowChromeCorners}>
              <View style={mainColumnStyle}>
                {!renderRoot ? renderMainHeader?.() : null}
                {renderRoot ? (
                  <SplitNodeView
                    renderMainHeader={renderMainHeader}
                    node={renderRoot}
                    workspaceKey={workspaceKey}
                    uiTabs={uiTabs}
                    focusedPaneId={layout.focusedPaneId}
                    normalizedServerId={normalizedServerId}
                    normalizedWorkspaceId={normalizedWorkspaceId}
                    isWorkspaceFocused={isWorkspaceFocused}
                    hoveredCloseTabKey={hoveredCloseTabKey}
                    setHoveredCloseTabKey={setHoveredCloseTabKey}
                    closingTabIds={closingTabIds}
                    onNavigateTab={onNavigateTab}
                    onCloseTab={onCloseTab}
                    onCopyResumeCommand={onCopyResumeCommand}
                    onCopyAgentId={onCopyAgentId}
                    onCopyTerminalId={onCopyTerminalId}
                    onCopyFilePath={onCopyFilePath}
                    onReloadAgent={onReloadAgent}
                    onRenameTab={onRenameTab}
                    onCloseTabsToLeft={onCloseTabsToLeft}
                    onCloseTabsToRight={onCloseTabsToRight}
                    onCloseOtherTabs={onCloseOtherTabs}
                    onCreateNewTab={onCreateNewTab}
                    buildPaneContentModel={buildPaneContentModel}
                    onFocusPane={onFocusPane}
                    onSplitPane={onSplitPane}
                    onSplitPaneEmpty={onSplitPaneEmpty}
                    onResizeSplit={onResizeSplit}
                    onReorderTabsInPane={onReorderTabsInPane}
                    activeDragTabId={activeDragTabId}
                    showDropZones={activeDragTabId !== null}
                    dropPreview={dropPreview}
                    tabDropPreview={tabDropPreview}
                    windowChromeCorners={windowChromeCorners}
                    maximizedPaneId={maximizedPaneId}
                    workspaceHasMultiplePanes={workspaceHasMultiplePanes}
                    onTogglePaneMaximized={handleTogglePaneMaximized}
                  />
                ) : null}
              </View>
            </WindowChromeRegion>
            <SupportingCardGroup
              resizeHandle={sidebarResizeHandle}
              renderHeader={renderToolbarSpacer}
              visible={renderExplorerSidebarDock}
              supportingVisible={Boolean(explorerSidebarPane?.tabIds.length)}
              hostName={cardHostName}
              style={explorerSidebarDockStyle}
            >
              {supportingCards}
            </SupportingCardGroup>
            <View
              style={sharedToolbarStyle}
              onLayout={measureToolbar}
              testID="workspace-shared-toolbar"
            >
              <PortalHost name={toolbarMenuHost} />
              <SharedToolbarActions
                renderActions={renderExplorerSidebarHeaderAction}
                visible={renderExplorerSidebarDock}
              />
            </View>
          </View>
        </WorkspaceChromeProviders>
        <DragOverlay dropAnimation={null}>
          {activeDragTabId ? (
            <DragOverlayTabChip
              tabId={activeDragTabId}
              uiTabs={uiTabs}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </RenderProfile>
  );
}

function DragOverlayTabChip({
  tabId,
  uiTabs,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  tabId: string;
  uiTabs: WorkspaceTab[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const tab = uiTabs.find((t) => t.tabId === tabId);
  const descriptor = useMemo<WorkspaceTabDescriptor | null>(
    () =>
      tab
        ? {
            key: tab.tabId,
            tabId: tab.tabId,
            kind: tab.target.kind,
            target: tab.target,
          }
        : null,
    [tab],
  );
  if (!descriptor) {
    return null;
  }
  return (
    <DragOverlayTabChipInner
      tab={descriptor}
      normalizedServerId={normalizedServerId}
      normalizedWorkspaceId={normalizedWorkspaceId}
    />
  );
}

function DragOverlayTabChipInner({
  tab,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  tab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const { t } = useTranslation();

  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => {
        const label =
          presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;

        return (
          <View style={styles.dragOverlayChip}>
            <WorkspaceTabIcon presentation={presentation} active size={14} backdrop="surface1" />
            <Text numberOfLines={1} style={styles.dragOverlayLabel}>
              {label}
            </Text>
          </View>
        );
      }}
    </WorkspaceTabPresentationResolver>
  );
}

function SplitGroupChild({
  resizeFlex,
  index,
  hidden,
  children,
}: {
  resizeFlex: SharedValue<number[]>;
  index: number;
  hidden: boolean;
  children: ReactNode;
}) {
  const resizeStyle = useAnimatedStyle(() => ({
    flexGrow: resizeFlex.value[index] ?? 0,
  }));
  const childStyle = useMemo(
    () => [
      styles.groupChild,
      {
        flexShrink: hidden ? 0 : 1,
        flexBasis: 0,
        ...(hidden ? { width: 0, height: 0 } : {}),
      },
    ],
    [hidden],
  );
  return (
    <Animated.View
      style={[childStyle, resizeStyle]}
      testID={hidden ? "split-group-child-hidden" : "split-group-child"}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Flex grow per child, renormalized so the visible ones always sum to 1.
 *
 * `sizes` are fractions, so a two-pane group is `[0.5, 0.5]`. Hiding one child drops the group's
 * total grow factor to 0.5, and CSS hands children that sum to less than 1 only that fraction of
 * the free space — the other half of the row is simply left empty. Renormalizing is what makes a
 * hidden pane give its space back instead of just going invisible. The stored `sizes` are never
 * touched, so unhiding restores the width the user dragged to.
 */
function resolveVisibleGroupFlex(
  children: SplitNode[],
  sizes: number[],
  maximizedPaneId: string | null,
): number[] {
  const visibleTotal = children.reduce(
    (total, child, index) =>
      isSplitNodeHiddenForPresentation(child, maximizedPaneId)
        ? total
        : total + (sizes[index] ?? 1),
    0,
  );
  if (visibleTotal <= 0) {
    return children.map(() => 0);
  }
  return children.map((child, index) =>
    isSplitNodeHiddenForPresentation(child, maximizedPaneId)
      ? 0
      : (sizes[index] ?? 1) / visibleTotal,
  );
}

function isSplitNodeHiddenForPresentation(
  node: SplitNode,
  maximizedPaneId: string | null,
): boolean {
  return (
    isSplitNodeHidden(node) ||
    Boolean(maximizedPaneId && !splitNodeContainsPane(node, maximizedPaneId))
  );
}

function isSplitNodeHidden(node: SplitNode): boolean {
  if (node.kind === "pane") {
    return node.pane.hidden === true;
  }
  return node.group.children.every(isSplitNodeHidden);
}

function SplitNodeView({
  node,
  renderMainHeader,
  workspaceKey,
  uiTabs,
  focusedPaneId,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateNewTab,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onResizeSplit,
  onReorderTabsInPane,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
  windowChromeCorners,
  maximizedPaneId,
  workspaceHasMultiplePanes,
  onTogglePaneMaximized,
}: SplitNodeViewProps) {
  const [groupContainerSize, setGroupContainerSize] = useState(0);
  const groupId = node.kind === "group" ? node.group.id : null;
  const groupDirection = node.kind === "group" ? node.group.direction : null;

  const storedGroupSizes = useWorkspaceLayoutStore((state) =>
    groupId ? state.splitSizesByWorkspace[workspaceKey]?.[groupId] : undefined,
  );
  const groupChildren = node.kind === "group" ? node.group.children : EMPTY_SPLIT_NODES;
  const groupSizes =
    storedGroupSizes ?? (node.kind === "group" ? node.group.sizes : EMPTY_SPLIT_SIZES);
  const visibleFlex = useMemo(
    () => resolveVisibleGroupFlex(groupChildren, groupSizes, maximizedPaneId),
    [groupChildren, groupSizes, maximizedPaneId],
  );
  const resizeFlex = useSharedValue(visibleFlex);
  useEffect(() => {
    resizeFlex.value = visibleFlex;
  }, [resizeFlex, visibleFlex]);
  const previewResizeSplit = useCallback(
    (_groupId: string, sizes: number[]) => {
      resizeFlex.value = resolveVisibleGroupFlex(groupChildren, sizes, maximizedPaneId);
    },
    [groupChildren, maximizedPaneId, resizeFlex],
  );
  const handleGroupLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextSize =
        groupDirection === "horizontal"
          ? event.nativeEvent.layout.width
          : event.nativeEvent.layout.height;
      setGroupContainerSize((current) => (current === nextSize ? current : nextSize));
    },
    [groupDirection],
  );

  const groupStyle = useMemo(
    () => [
      styles.group,
      groupDirection === "horizontal" ? styles.groupHorizontal : styles.groupVertical,
    ],
    [groupDirection],
  );

  if (node.kind === "pane") {
    return (
      <RetainedPanel
        active={node.pane.hidden !== true && (!maximizedPaneId || node.pane.id === maximizedPaneId)}
      >
        <WindowChromeRegion corners={windowChromeCorners}>
          <SplitPaneView
            renderMainHeader={renderMainHeader}
            pane={node.pane}
            uiTabs={uiTabs}
            isFocused={node.pane.id === focusedPaneId}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
            isWorkspaceFocused={isWorkspaceFocused}
            hoveredCloseTabKey={hoveredCloseTabKey}
            setHoveredCloseTabKey={setHoveredCloseTabKey}
            closingTabIds={closingTabIds}
            onNavigateTab={onNavigateTab}
            onCloseTab={onCloseTab}
            onCopyResumeCommand={onCopyResumeCommand}
            onCopyAgentId={onCopyAgentId}
            onCopyTerminalId={onCopyTerminalId}
            onCopyFilePath={onCopyFilePath}
            onReloadAgent={onReloadAgent}
            onRenameTab={onRenameTab}
            onCloseTabsToLeft={onCloseTabsToLeft}
            onCloseTabsToRight={onCloseTabsToRight}
            onCloseOtherTabs={onCloseOtherTabs}
            onCreateNewTab={onCreateNewTab}
            buildPaneContentModel={buildPaneContentModel}
            onFocusPane={onFocusPane}
            onSplitPane={onSplitPane}
            onSplitPaneEmpty={onSplitPaneEmpty}
            onReorderTabsInPane={onReorderTabsInPane}
            activeDragTabId={activeDragTabId}
            showDropZones={showDropZones}
            dropPreview={dropPreview}
            tabDropPreview={tabDropPreview}
            maximizedPaneId={maximizedPaneId}
            workspaceHasMultiplePanes={workspaceHasMultiplePanes}
            onTogglePaneMaximized={onTogglePaneMaximized}
          />
        </WindowChromeRegion>
      </RetainedPanel>
    );
  }

  return (
    <View style={groupStyle} onLayout={handleGroupLayout}>
      {node.group.children.map((child, index) => (
        <Fragment key={getNodeKey(child)}>
          <SplitGroupChild
            resizeFlex={resizeFlex}
            index={index}
            hidden={isSplitNodeHiddenForPresentation(child, maximizedPaneId)}
          >
            <SplitNodeView
              renderMainHeader={
                index ===
                node.group.children.findIndex(
                  (candidate) => !isSplitNodeHiddenForPresentation(candidate, maximizedPaneId),
                )
                  ? renderMainHeader
                  : undefined
              }
              node={child}
              workspaceKey={workspaceKey}
              uiTabs={uiTabs}
              focusedPaneId={focusedPaneId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              hoveredCloseTabKey={hoveredCloseTabKey}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              closingTabIds={closingTabIds}
              onNavigateTab={onNavigateTab}
              onCloseTab={onCloseTab}
              onCopyResumeCommand={onCopyResumeCommand}
              onCopyAgentId={onCopyAgentId}
              onCopyTerminalId={onCopyTerminalId}
              onCopyFilePath={onCopyFilePath}
              onReloadAgent={onReloadAgent}
              onRenameTab={onRenameTab}
              onCloseTabsToLeft={onCloseTabsToLeft}
              onCloseTabsToRight={onCloseTabsToRight}
              onCloseOtherTabs={onCloseOtherTabs}
              onCreateNewTab={onCreateNewTab}
              buildPaneContentModel={buildPaneContentModel}
              onFocusPane={onFocusPane}
              onSplitPane={onSplitPane}
              onSplitPaneEmpty={onSplitPaneEmpty}
              onResizeSplit={onResizeSplit}
              onReorderTabsInPane={onReorderTabsInPane}
              activeDragTabId={activeDragTabId}
              showDropZones={showDropZones}
              dropPreview={dropPreview}
              tabDropPreview={tabDropPreview}
              windowChromeCorners={windowChromeCorners}
              maximizedPaneId={maximizedPaneId}
              workspaceHasMultiplePanes={workspaceHasMultiplePanes}
              onTogglePaneMaximized={onTogglePaneMaximized}
            />
          </SplitGroupChild>
          {index < node.group.children.length - 1 &&
          !isSplitNodeHiddenForPresentation(child, maximizedPaneId) &&
          !isSplitNodeHiddenForPresentation(node.group.children[index + 1], maximizedPaneId) ? (
            <ResizeHandle
              testID="workspace-split-resize-handle"
              direction={node.group.direction}
              groupId={node.group.id}
              index={index}
              sizes={groupSizes}
              containerSize={groupContainerSize}
              onPreviewResizeSplit={previewResizeSplit}
              onResizeSplit={onResizeSplit}
            />
          ) : null}
        </Fragment>
      ))}
    </View>
  );
}

function SplitPaneView({
  pane,
  renderMainHeader,
  uiTabs,
  isFocused,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateNewTab,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane: _onSplitPane,
  onSplitPaneEmpty,
  onReorderTabsInPane,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
  maximizedPaneId,
  workspaceHasMultiplePanes,
  onTogglePaneMaximized,
}: SplitPaneViewProps) {
  const paneRef = useRef<View | null>(null);
  const stableOnFocusPane = useStableEvent(onFocusPane);
  const paneState = useMemo(
    () =>
      deriveWorkspacePaneState({
        pane,
        tabs: uiTabs,
      }),
    [pane, uiTabs],
  );
  const paneTabs = useMemo(() => paneState.tabs.map((tab) => tab.descriptor), [paneState.tabs]);
  const activeTabDescriptor = paneState.activeTab?.descriptor ?? null;
  const desktopTabRowItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      paneTabs.map((tab) => ({
        tab,
        isActive: tab.key === activeTabDescriptor?.key,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
      })),
    [activeTabDescriptor?.key, closingTabIds, hoveredCloseTabKey, paneTabs],
  );

  useEffect(() => {
    if (isNative) {
      return () => {};
    }

    const rawRef: unknown = paneRef.current;
    if (!(rawRef instanceof HTMLElement)) {
      return () => {};
    }
    const paneElement = rawRef;

    const handlePanePointerDown = (event: PointerEvent) => {
      if (!shouldFocusPaneFromEventTarget(event.target)) {
        return;
      }
      stableOnFocusPane(pane.id);
    };

    const handlePaneFocusIn = (event: FocusEvent) => {
      if (!shouldFocusPaneFromEventTarget(event.target)) {
        return;
      }
      stableOnFocusPane(pane.id);
    };

    paneElement.addEventListener("pointerdown", handlePanePointerDown, true);
    paneElement.addEventListener("focusin", handlePaneFocusIn, true);

    return () => {
      paneElement.removeEventListener("pointerdown", handlePanePointerDown, true);
      paneElement.removeEventListener("focusin", handlePaneFocusIn, true);
    };
  }, [stableOnFocusPane, pane.id]);

  const paneId = pane.id;
  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => onCloseTabsToLeft(tabId, paneTabs),
    [onCloseTabsToLeft, paneTabs],
  );
  const handleCloseTabsToRight = useCallback(
    (tabId: string) => onCloseTabsToRight(tabId, paneTabs),
    [onCloseTabsToRight, paneTabs],
  );
  const handleCloseOtherTabs = useCallback(
    (tabId: string) => onCloseOtherTabs(tabId, paneTabs),
    [onCloseOtherTabs, paneTabs],
  );
  const handleReorderTabs = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      onReorderTabsInPane(
        paneId,
        nextTabs.map((tab) => tab.tabId),
      );
    },
    [onReorderTabsInPane, paneId],
  );
  const handleSplitRight = useCallback(
    () => onSplitPaneEmpty({ targetPaneId: paneId, position: "right" }),
    [onSplitPaneEmpty, paneId],
  );
  const handleSplitDown = useCallback(
    () => onSplitPaneEmpty({ targetPaneId: paneId, position: "bottom" }),
    [onSplitPaneEmpty, paneId],
  );
  const handleTogglePaneMaximized = useCallback(
    () => onTogglePaneMaximized(paneId),
    [onTogglePaneMaximized, paneId],
  );
  return (
    <RenderProfile id={`SplitPaneView:${pane.id}`}>
      <View
        ref={paneRef}
        collapsable={false}
        style={styles.pane}
        testID={`workspace-pane-${pane.id}`}
      >
        <WindowChromeSafeArea placement="inline" style={styles.paneTabs}>
          <TitlebarDragRegion />
          <WorkspaceDesktopTabsRow
            paneId={pane.id}
            isFocused={isFocused && isWorkspaceFocused}
            tabs={desktopTabRowItems}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
            setHoveredCloseTabKey={setHoveredCloseTabKey}
            onNavigateTab={onNavigateTab}
            onCloseTab={onCloseTab}
            onCopyResumeCommand={onCopyResumeCommand}
            onCopyAgentId={onCopyAgentId}
            onCopyTerminalId={onCopyTerminalId}
            onCopyFilePath={onCopyFilePath}
            onReloadAgent={onReloadAgent}
            onRenameTab={onRenameTab}
            onCloseTabsToLeft={handleCloseTabsToLeft}
            onCloseTabsToRight={handleCloseTabsToRight}
            onCloseOtherTabs={handleCloseOtherTabs}
            onCreateNewTab={onCreateNewTab}
            onReorderTabs={handleReorderTabs}
            externalDndContext
            activeDragTabId={activeDragTabId}
            tabDropPreviewIndex={
              tabDropPreview?.paneId === pane.id ? tabDropPreview.indicatorIndex : null
            }
            showPaneSplitActions
            showPaneMaximizeAction={workspaceHasMultiplePanes}
            paneMaximized={paneId === maximizedPaneId}
            onTogglePaneMaximized={handleTogglePaneMaximized}
            onSplitRight={handleSplitRight}
            onSplitDown={handleSplitDown}
          />
        </WindowChromeSafeArea>

        {renderMainHeader?.()}
        <View style={styles.paneContent}>
          <WorkspacePanelHost
            paneId={pane.id}
            tabs={paneTabs}
            activeTabId={activeTabDescriptor?.tabId ?? null}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
            isWorkspaceFocused={isWorkspaceFocused}
            isPaneFocused={isFocused}
            onFocusPane={stableOnFocusPane}
            buildPaneContentModel={buildPaneContentModel}
          />
          <SplitDropZone paneId={pane.id} active={showDropZones} preview={dropPreview} />
        </View>
      </View>
    </RenderProfile>
  );
}

function collectPanesById(node: SplitNode): Map<string, SplitPane> {
  const next = new Map<string, SplitPane>();
  function visit(current: SplitNode) {
    if (current.kind === "pane") {
      next.set(current.pane.id, current.pane);
      return;
    }
    for (const child of current.group.children) {
      visit(child);
    }
  }
  visit(node);
  return next;
}

function getNodeKey(node: SplitNode): string {
  if (node.kind === "pane") {
    return node.pane.id;
  }
  return node.group.id;
}

function wrapRootPaneForStableMount(node: SplitNode): SplitNode {
  if (node.kind === "group") {
    return node;
  }

  return {
    kind: "group",
    group: {
      id: `root:${node.pane.id}`,
      direction: "horizontal",
      children: [node],
      sizes: [1],
    },
  };
}

function removePaneFromSplitTree(node: SplitNode, paneId: string | null): SplitNode | null {
  if (!paneId) {
    return node;
  }
  if (node.kind === "pane") {
    return node.pane.id === paneId ? null : node;
  }

  const children = node.group.children.flatMap((child) => {
    const nextChild = removePaneFromSplitTree(child, paneId);
    return nextChild ? [nextChild] : [];
  });
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0] ?? null;
  }
  return {
    kind: "group",
    group: {
      ...node.group,
      children,
      sizes: children.map(() => 1 / children.length),
    },
  };
}

function topRightToolbarPane(node: SplitNode | null): string | null {
  if (!node || isSplitNodeHidden(node)) return null;
  if (node.kind === "pane") return node.pane.id;
  const children = node.group.children.filter((child) => !isSplitNodeHidden(child));
  return topRightToolbarPane(
    (node.group.direction === "horizontal" ? children.at(-1) : children[0]) ?? null,
  );
}

function useSharedToolbarGeometry(
  renderExplorerSidebarDock: boolean,
  explorerSidebarWidth: number,
  workspaceShellWidth: number,
  root: SplitNode | null,
  maximizedPaneId: string | null,
) {
  const paneId = maximizedPaneId ?? topRightToolbarPane(root);
  const toolbarMenuHost = `workspace-toolbar-${useId()}`;
  const [toolbarWidth, setToolbarWidth] = useState(0);
  const measureToolbar = useCallback((event: LayoutChangeEvent) => {
    setToolbarWidth(event.nativeEvent.layout.width);
  }, []);
  const toolbarContext = useMemo(
    () => ({
      menuHost: toolbarMenuHost,
      paneId,
      reservedWidth: Math.max(
        0,
        toolbarWidth +
          FLOATING_PANEL_INSET -
          (renderExplorerSidebarDock ? explorerSidebarWidth : 0),
      ),
    }),
    [toolbarMenuHost, toolbarWidth, renderExplorerSidebarDock, explorerSidebarWidth, paneId],
  );
  const sharedToolbarStyle = useMemo(
    () => [
      styles.sharedToolbar,
      {
        maxWidth: Math.max(80, workspaceShellWidth - 120),
        opacity: toolbarWidth > 0 ? 1 : 0,
      },
    ],
    [workspaceShellWidth, toolbarWidth],
  );
  return { toolbarMenuHost, toolbarContext, sharedToolbarStyle, measureToolbar };
}

function WorkspaceChromeProviders({
  toolbar,
  cards,
  children,
}: {
  toolbar: { menuHost: string; reservedWidth: number; paneId: string | null };
  cards: { agentId: string | null; hostName: string };
  children: ReactNode;
}) {
  return (
    <SharedWorkspaceToolbarContext.Provider value={toolbar}>
      <SupportingCardsContext.Provider value={cards}>{children}</SupportingCardsContext.Provider>
    </SharedWorkspaceToolbarContext.Provider>
  );
}

function SharedToolbarActions({
  renderActions,
  visible,
}: {
  renderActions?: (visible: boolean) => ReactNode;
  visible: boolean;
}) {
  return renderActions?.(visible);
}

const renderToolbarSpacer = () => null;

const styles = StyleSheet.create((theme) => ({
  sharedToolbar: {
    position: "absolute",
    top: FLOATING_PANEL_INSET,
    right: FLOATING_PANEL_INSET,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    zIndex: 5,
    backgroundColor: theme.colors.surface0,
  },
  workspaceShell: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: "row",
  },
  mainColumn: {
    paddingTop: FLOATING_PANEL_INSET + 1,
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 0,
  },
  explorerSidebarDock: {
    flexGrow: 0,
    flexBasis: "auto",
    flexShrink: 0,
    minWidth: 240 - FLOATING_PANEL_INSET * 2,
    minHeight: 0,
    margin: FLOATING_PANEL_INSET,
    marginTop: FLOATING_PANEL_INSET + 1,
    marginBottom: FLOATING_PANEL_INSET,
  },
  group: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  groupHorizontal: {
    flexDirection: "row",
  },
  groupVertical: {
    flexDirection: "column",
  },
  groupChild: {
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
  },
  pane: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  paneTabs: {
    zIndex: 2,
    position: "relative",
    minWidth: 0,
  },
  paneContent: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  dragOverlayChip: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    maxWidth: 200,
  },
  dragOverlayLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
}));

interface SupportingCardGroupVisibility {
  collapsed?: boolean;
  supportingViewsVisible: boolean;
  cardsAgentId: string | null;
  workspaceShellWidth: number;
}

function shouldShowSupportingCardGroup({
  collapsed,
  supportingViewsVisible,
  cardsAgentId,
  workspaceShellWidth,
}: SupportingCardGroupVisibility): boolean {
  if (collapsed) return false;
  if (supportingViewsVisible) return true;
  if (!cardsAgentId) return false;
  return workspaceShellWidth >= COLUMN_BREAKPOINT;
}
