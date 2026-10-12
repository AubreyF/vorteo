import {
  SidebarWidthContext,
  sidebarPresentationWidth,
  useSidebarWidth,
} from "./sidebar/sidebar-width";
import { usePanelSpacing } from "@/styles/use-panel-spacing";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useResponsiveSidebar } from "@/hooks/use-responsive-sidebar";
import { InstallationRestartBanner } from "@/execution-installation/panel";
import { usePointerResize } from "./use-pointer-resize";
import { useMenuContext } from "@/components/ui/menu/menu-context";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ThemePreviewGrid } from "@/screens/settings/appearance/theme-preview-grid";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useOpenNewWorkspace } from "@/hooks/use-open-new-workspace";
import { useVortonTouch } from "@/vorton-touch";

import { router, usePathname } from "expo-router";
import { useVortonCompatibilityCallout } from "./vorton-compatibility-callout";
import { DemoControls } from "@/demo/controls";
import {
  Search,
  FolderPlus,
  Plus,
  History,
  CalendarClock,
  Settings2,
  GitBranch,
  Settings,
  MoreVertical,
  CircleHelp,
  PanelLeftOpen,
} from "lucide-react-native";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import {
  cloneElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Pressable,
  type LayoutChangeEvent,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { CompactProjectRail } from "./sidebar/compact-project-rail";
import { floatingPanelStyles } from "@/styles/floating-panel";
import { SIDEBAR_OUTER_GAP } from "@/stores/panel-store/state";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";

import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarSeparator, SidebarInsetContext } from "@/components/sidebar/sidebar-separator";
import { SidebarNavRows } from "@/components/sidebar/sidebar-nav-rows";
import { SidebarHelpMenu } from "@/components/sidebar/sidebar-help-menu";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  HEADER_INNER_HEIGHT,
  VORTON_HEADER_HEIGHT,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useImportSession } from "@/hooks/use-import-session";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";

import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { usePanelStore } from "@/stores/panel-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import {
  buildSchedulesRoute,
  buildSessionsRoute,
  buildSettingsAddHostRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import { openHostOverview } from "@/navigation/settings-navigation";
import { UsageSidebarItem, useHasUsageSummary } from "@/usage";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = Theme;

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

interface SidebarSharedProps {
  theme: SidebarTheme;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  hasActiveProjectFilter: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleImportSession: () => void;
  handleSettings: () => void;
  labels: SidebarLabels;
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
}

interface SidebarLabels {
  addProject: string;
  hosts: string;
  settings: string;
  searchHosts: string;
  usage: string;
  closeSidebar: string;
  importSession: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  active: boolean;
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
}

const LeftSidebarBase = memo(function LeftSidebarBase({
  active,
  theme,
}: {
  active: boolean;
  theme: Theme;
}) {
  useVortonCompatibilityCallout();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const {
    projects,
    hasProjectsBeforeFilter,
    resolvedProjectFilters,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();
  const { open: openImportSession, sheet: importSessionSheet } = useImportSession();

  const handleOpenProjectMobile = useCallback(() => {
    showMobileAgent();
    void openProjectPicker();
  }, [showMobileAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettingsMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleSettingsDesktop = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleAddHostMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, [showMobileAgent]);

  const handleAddHostDesktop = useCallback(() => {
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, []);

  const handleOpenHostSettingsMobile = useCallback(
    (serverId: string) => {
      showMobileAgent();
      openHostOverview(serverId);
    },
    [showMobileAgent],
  );

  const handleOpenHostSettingsDesktop = useCallback((serverId: string) => {
    openHostOverview(serverId);
  }, []);

  const handleImportSessionMobile = useCallback(() => {
    showMobileAgent();
    openImportSession();
  }, [openImportSession, showMobileAgent]);

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      hosts: t("sidebar.actions.hosts"),
      settings: t("sidebar.actions.settings"),
      searchHosts: t("sidebar.host.searchPlaceholder"),
      usage: t(builtinSidebarNavLabelKey("usage")),
      importSession: t("sidebar.actions.importSession"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    projects,
    hasProjectsBeforeFilter,
    hasActiveProjectFilter: resolvedProjectFilters.length > 0,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    labels,
  };

  if (isCompactLayout) {
    return (
      <>
        <RetainedPanelActivity active={active}>
          <MobileSidebar
            {...sharedProps}
            active={active}
            insetsTop={insets.top}
            insetsBottom={insets.bottom}
            closeSidebar={showMobileAgent}
            handleOpenProject={handleOpenProjectMobile}
            handleImportSession={handleImportSessionMobile}
            handleSettings={handleSettingsMobile}
            handleAddHost={handleAddHostMobile}
            handleOpenHostSettings={handleOpenHostSettingsMobile}
          />
        </RetainedPanelActivity>
        {importSessionSheet}
      </>
    );
  }

  return (
    <>
      <RetainedPanelActivity active={active}>
        <DesktopSidebar
          {...sharedProps}
          insetsTop={insets.top}
          active={active}
          handleOpenProject={handleOpenProjectDesktop}
          handleImportSession={openImportSession}
          handleSettings={handleSettingsDesktop}
          handleAddHost={handleAddHostDesktop}
          handleOpenHostSettings={handleOpenHostSettingsDesktop}
        />
      </RetainedPanelActivity>
      {importSessionSheet}
    </>
  );
});

const ThemedLeftSidebar = withUnistyles(LeftSidebarBase);
const sidebarThemeMapping = (theme: Theme) => ({ theme });
export function LeftSidebar({ active }: { active: boolean }) {
  return <ThemedLeftSidebar active={active} uniProps={sidebarThemeMapping} />;
}

function FooterIconButton({
  disabled = false,
  active = false,
  buttonRef,
  onPress,
  testID,
  label,
  icon: Icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
  alternateShortcutKeys,
  theme,
}: {
  disabled?: boolean;
  active?: boolean;
  onPress: () => void;
  testID: string;
  label: string;
  icon: typeof FolderPlus;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  alternateShortcutKeys?: ReturnType<typeof useShortcutKeys>;
  theme: SidebarTheme;
  buttonRef?: RefObject<View | null>;
}) {
  const touch = useVortonTouch();
  const rail = useSidebarWidth() <= 96;
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const isCompact = useIsCompactFormFactor();
  const iconSize = isCompact ? theme.iconSize.xl : theme.iconSize.md;

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          disabled={disabled}
          style={[
            styles.footerIconButton(isCompact),
            (touch || rail) && styles.touchIconButton,
            active && styles.activeIconButton,
          ]}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={accessibilityState}
          onPress={onPress}
        >
          {({ hovered }) => (
            <Icon
              size={iconSize + iconSizeAdjustment}
              color={hovered || active ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
        <IconTooltipContent
          label={label}
          shortcutKeys={shortcutKeys}
          alternateShortcutKeys={alternateShortcutKeys}
        />
      </TooltipContent>
    </Tooltip>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
  alternateShortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  alternateShortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
      {shortcutKeys && alternateShortcutKeys ? <Text style={styles.tooltipText}>/</Text> : null}
      {alternateShortcutKeys ? <Shortcut chord={alternateShortcutKeys} /> : null}
    </View>
  );
}

function SidebarToolbar({
  rail = false,
  railFooter,
  onExpand,
  theme,
  handleOpenProject,
  handleSettings,
  labels,
  onBeforeNavigate,
}: {
  rail?: boolean;
  railFooter?: boolean;
  onExpand?: () => void;
  handleImportSession: () => void;
  theme: SidebarTheme;
  handleOpenProject: () => void;
  handleSettings: () => void;
  labels: {
    addProject: string;
    hosts: string;
    settings: string;
    searchHosts: string;
    usage: string;
    importSession: string;
  };
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
  onBeforeNavigate?: () => void;
}) {
  const handleNewWorkspace = useOpenNewWorkspace(onBeforeNavigate);
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handleSearch = useCallback(() => {
    onBeforeNavigate?.();
    setCommandCenterOpen(true);
  }, [onBeforeNavigate, setCommandCenterOpen]);

  const settingsKeys = useShortcutKeys("toggle-settings");
  const searchKeys = useShortcutKeys("toggle-command-center");
  const alternateSearchKeys = useShortcutKeys("toggle-command-center-alternate");
  const { t } = useTranslation();

  const [helpOpen, setHelpOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);

  const pathname = usePathname();
  const touch = useVortonTouch();
  const openHistory = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);
  const openSchedules = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const openDisplay = useCallback(() => setDisplayOpen(true), []);
  const menuIcons = useMemo(
    () => ({
      settings: <Settings size={16} color={theme.colors.foregroundMuted} />,
      schedules: <CalendarClock size={16} color={theme.colors.foregroundMuted} />,
      history: <History size={16} color={theme.colors.foregroundMuted} />,
      project: <FolderPlus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      help: <CircleHelp size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      workspace: <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      display: <Settings2 size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    }),
    [theme.iconSize.sm, theme.colors.foregroundMuted],
  );
  const width = useSidebarWidth();
  const showHistory = !rail && width >= 300;
  const showSchedules = !rail && width >= 260;
  const showSettings = !rail && width >= 340;
  const more = useMemo(
    () => (
      <View>
        <SidebarHelpMenu hiddenTrigger controlledOpen={helpOpen} onOpenChange={setHelpOpen} />
        <SidebarDisplayPreferencesMenu
          hiddenTrigger
          controlledOpen={displayOpen}
          onOpenChange={setDisplayOpen}
        />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger
                style={[styles.footerIconButton(false), (touch || rail) && styles.touchIconButton]}
                accessibilityLabel="More sidebar actions"
                accessibilityRole="button"
                testID="sidebar-footer-overflow"
              >
                <MoreVertical size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side={rail ? "right" : "bottom"}>
              <IconTooltipContent label="More sidebar actions" />
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side={rail ? "right" : "bottom"} align="start" width={360}>
            <DropdownMenuItem onSelect={handleSettings} leading={menuIcons.settings}>
              Settings
            </DropdownMenuItem>
            {!showSchedules && !rail ? (
              <DropdownMenuItem onSelect={openSchedules} leading={menuIcons.schedules}>
                Schedules
              </DropdownMenuItem>
            ) : null}
            {!showHistory && !rail ? (
              <DropdownMenuItem onSelect={openHistory} leading={menuIcons.history}>
                History
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            <DropdownMenuItem
              testID="sidebar-add-project"
              onSelect={handleOpenProject}
              leading={menuIcons.project}
            >
              {labels.addProject}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID="sidebar-global-new-workspace"
              onSelect={handleNewWorkspace}
              leading={menuIcons.workspace}
            >
              {t("sidebar.actions.newWorkspace")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <View style={styles.themeMenu}>
              <SidebarThemePicker />
            </View>
            <DropdownMenuItem
              testID="sidebar-display-preferences-action"
              onSelect={openDisplay}
              leading={menuIcons.display}
            >
              {t("sidebar.display.viewPreferences")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              testID="sidebar-help-action"
              onSelect={openHelp}
              leading={menuIcons.help}
            >
              {t("sidebar.help.trigger")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    ),
    [
      helpOpen,
      displayOpen,
      touch,
      rail,
      theme,
      handleSettings,
      showSchedules,
      openSchedules,
      showHistory,
      openHistory,
      handleOpenProject,
      handleNewWorkspace,
      labels.addProject,
      t,
      openDisplay,
      openHelp,
      menuIcons,
    ],
  );
  const history = (
    <FooterIconButton
      testID="sidebar-sessions"
      icon={History}
      onPress={openHistory}
      active={pathname.includes("/sessions")}
      label={t(builtinSidebarNavLabelKey("history"))}
      theme={theme}
    />
  );
  const schedules = (
    <FooterIconButton
      testID="sidebar-schedules"
      icon={CalendarClock}
      onPress={openSchedules}
      active={pathname.includes("/schedules")}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      theme={theme}
    />
  );
  if (railFooter) return more;
  return (
    <>
      <View
        style={rail ? styles.railToolbar : [styles.sidebarFooter, styles.sidebarToolbar]}
        testID="sidebar-toolbar"
      >
        {rail && onExpand ? (
          <FooterIconButton
            icon={PanelLeftOpen}
            onPress={onExpand}
            label="Expand sidebar"
            testID="sidebar-expand"
            theme={theme}
          />
        ) : (
          <SidebarMenuToggle insideSidebar testID="sidebar-collapse" />
        )}
        <FooterIconButton
          icon={Search}
          onPress={handleSearch}
          label={t("sidebar.sections.search")}
          shortcutKeys={searchKeys}
          alternateShortcutKeys={alternateSearchKeys}
          testID="sidebar-search"
          theme={theme}
        />
        {!rail ? <View style={styles.footerGap} /> : null}
        {showHistory ? history : null}
        {showSchedules || rail ? schedules : null}
        {rail ? history : null}
        {showSettings ? (
          <FooterIconButton
            onPress={handleSettings}
            testID="sidebar-settings"
            label={labels.settings}
            icon={Settings}
            shortcutKeys={settingsKeys}
            theme={theme}
          />
        ) : null}
        {!rail ? more : null}
        {!rail ? <SidebarSeparator edge="bottom" testID="sidebar-toolbar-divider" /> : null}
      </View>
      {!rail && width < 260 ? (
        <View style={styles.narrowNavigation}>
          <Button
            variant="ghost"
            leftIcon={CalendarClock}
            onPress={openSchedules}
            style={styles.narrowNavigationRow}
          >
            Schedules
          </Button>
          <Button
            variant="ghost"
            leftIcon={History}
            onPress={openHistory}
            style={styles.narrowNavigationRow}
          >
            History
          </Button>
          <Button
            variant="ghost"
            leftIcon={Settings}
            onPress={handleSettings}
            style={styles.narrowNavigationRow}
          >
            Settings
          </Button>
        </View>
      ) : null}
    </>
  );
}

/**
 * The footer rows in the user's `sidebarFooterItems` order: the Usage item and plugin rows. The
 * Usage item is left out while it has no summary to show.
 */

function SidebarFooterRows({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { items } = useSidebarNavItems("footer");
  const hasUsageSummary = useHasUsageSummary();
  const rowsRef = useRef<View | null>(null);
  const visibleItems = items.filter(
    (item) => item.visible && (item.kind === "plugin" || hasUsageSummary),
  );
  if (visibleItems.length === 0) return null;
  return (
    <>
      <View ref={rowsRef} collapsable={false} style={styles.footerRows}>
        {visibleItems.map((item) =>
          item.kind === "plugin" ? (
            <PluginSidebarItem
              key={item.key}
              group={item.group}
              section="footer"
              fallbackAnchorRef={rowsRef}
              onBeforeNavigate={onBeforeNavigate}
            />
          ) : (
            <UsageSidebarItem key={item.key} />
          ),
        )}
      </View>
      <SidebarSeparator testID="sidebar-footer-separator" />
    </>
  );
}

function MobileSidebar({
  active,
  theme,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const touch = useVortonTouch();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const { inset: spacingInset, onLayout: onPanelLayout } = usePanelSpacing();
  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      // The footer already supplies 12px. Use one 16px mobile edge margin
      // instead of stacking a second empty safe-area strip beneath it.
      paddingBottom: touch ? theme.spacing[1] : insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar, theme.spacing, touch],
  );

  const navigation = useMemo(
    () => <SidebarNavRows style={styles.scrollingNavGroup} onBeforeNavigate={closeSidebar} />,
    [closeSidebar],
  );
  const toolbar = (
    <SidebarToolbar
      onBeforeNavigate={closeSidebar}
      theme={theme}
      handleOpenProject={handleOpenProject}
      handleImportSession={handleImportSession}
      handleSettings={handleSettings}
      labels={labels}
      handleAddHost={handleAddHost}
      handleOpenHostSettings={handleOpenHostSettings}
    />
  );
  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View
        style={[styles.sidebarContent, inlineUnistylesStyle({ padding: spacingInset })]}
        onLayout={onPanelLayout}
        pointerEvents="auto"
      >
        <WindowChromeSafeArea placement="below" />
        <SidebarInsetContext.Provider value={spacingInset}>
          {toolbar}

          {isInitialLoad && !hasActiveHostFilter ? (
            <>
              {navigation}
              <SidebarAgentListSkeleton />
            </>
          ) : (
            <SidebarWorkspaceList
              collapsedProjectKeys={collapsedProjectKeys}
              onToggleProjectCollapsed={toggleProjectCollapsed}
              shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
              groupMode={groupMode}
              workspaceGroups={workspaceGroups}
              projectIconTargets={projectIconTargets}
              pinnedGroups={pinnedGroups}
              projects={projects}
              hasProjectsBeforeFilter={hasProjectsBeforeFilter}
              hasActiveProjectFilter={hasActiveProjectFilter}
              workspaceEntriesByKey={workspaceEntriesByKey}
              isRefreshing={isManualRefresh && isRevalidating}
              onRefresh={handleRefresh}
              onWorkspacePress={handleWorkspacePress}
              onAddProject={handleOpenProject}
              onImportSession={handleImportSession}
              parentGestureRef={closeGestureRef}
              dragGestureHostActive={active}
              listTopComponent={navigation}
              listHeaderComponent={undefined}
            />
          )}

          <InstallationRestartBanner placement="sidebar" />
          <DemoControls />
          {<SidebarFooterRows onBeforeNavigate={closeSidebar} />}
        </SidebarInsetContext.Provider>
      </View>
    </MobilePanelOverlay>
  );
}

function SidebarPresentation({
  width,
  inset,
  children,
}: {
  width: number;
  inset: number;
  children: React.ReactNode;
}) {
  return (
    <SidebarWidthContext.Provider value={width}>
      <SidebarInsetContext.Provider value={inset}>{children}</SidebarInsetContext.Provider>
    </SidebarWidthContext.Provider>
  );
}

function DesktopSidebar({
  theme,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  active,
}: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const { sidebarCompact: savedCompact, sidebarNarrow: narrow } = useResponsiveSidebar();
  const [measuredWidth, setMeasuredWidth] = useState(sidebarPresentationWidth(sidebarWidth));
  const [resizePressed, setResizePressed] = useState(false);
  const compact = resizePressed ? measuredWidth <= 96 : savedCompact;
  const setCompact = usePanelStore((state) => state.setSidebarCompact);
  const expandSidebar = useCallback(() => {
    setCompact(false);
  }, [setCompact]);
  const showAllProjects = useSidebarViewStore((state) => state.clearProjectFilters);
  const selectRailProject = useCallback(
    (key: string) => {
      // Use the same projection as the sidebar filters so pinned rows, status groups
      // and keyboard shortcuts all follow the chosen project.
      useSidebarViewStore.setState({ projectFilters: [key] });
      if (collapsedProjectKeys.has(key)) toggleProjectCollapsed(key);
      setCompact(false);
    },
    [collapsedProjectKeys, setCompact, toggleProjectCollapsed],
  );
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
    compact: savedCompact,
    narrow,
    hasTopLeftWindowControls: ownsTopLeft,
  });

  const startWidthRef = useRef(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const beginPointerResize = useCallback(() => {
    const initialWidth = visibleSidebarWidth;
    let nextWidth = initialWidth;
    return {
      move: (delta: number) => {
        nextWidth = resolveDesktopSidebarWidth({
          requestedWidth: initialWidth + delta,
          viewportWidth,
        });
        resizeWidth.value = nextWidth;
        setMeasuredWidth(sidebarPresentationWidth(nextWidth));
      },
      finish: () => setSidebarWidth(nextWidth),
    };
  }, [visibleSidebarWidth, viewportWidth, resizeWidth, setSidebarWidth]);
  const handlePointerResize = usePointerResize({
    direction: "horizontal",
    begin: beginPointerResize,
    onDraggingChange: setResizePressed,
  });

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the workspace list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const desktopSidebarStyle = useMemo(
    () => [
      staticStyles.desktopSidebar,
      !active && staticStyles.desktopSidebarHidden,
      resizeAnimatedStyle,
    ],
    [active, resizeAnimatedStyle],
  );
  const { inset: spacingInset, onLayout: onPanelLayout } = usePanelSpacing();
  const desktopSidebarBorderStyle = useMemo(
    () => [
      floatingPanelStyles.surface,
      inlineUnistylesStyle({
        flex: 1,
        padding: compact ? 0 : spacingInset,
        paddingTop: insetsTop + (compact ? 0 : spacingInset),
      }),
    ],
    [insetsTop, compact, spacingInset],
  );

  const navigation = useMemo(() => <SidebarNavRows style={styles.scrollingNavGroup} />, []);
  const toolbar = useMemo(
    () => (
      <SidebarToolbar
        rail={compact}
        onExpand={expandSidebar}
        theme={theme}
        handleOpenProject={handleOpenProject}
        handleImportSession={handleImportSession}
        handleSettings={handleSettings}
        labels={labels}
        handleAddHost={handleAddHost}
        handleOpenHostSettings={handleOpenHostSettings}
      />
    ),
    [
      compact,
      expandSidebar,
      theme,
      handleOpenProject,
      handleImportSession,
      handleSettings,
      labels,
      handleAddHost,
      handleOpenHostSettings,
    ],
  );
  const railFooter = useMemo(
    () => cloneElement(toolbar, { rail: true, railFooter: true }),
    [toolbar],
  );
  const measureSidebar = useCallback(
    (event: LayoutChangeEvent) =>
      setMeasuredWidth(sidebarPresentationWidth(event.nativeEvent.layout.width)),
    [],
  );
  const devBadge = DEV_BUILD_LABEL ? (
    <View
      pointerEvents="none"
      style={styles.devBuildBadge}
      testID="dev-build-label"
      accessibilityLabel={`Development build: ${DEV_BUILD_LABEL}`}
    >
      <GitBranch size={12} color={theme.colors.accentForeground} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
        {DEV_BUILD_LABEL}
      </Text>
    </View>
  ) : null;
  return (
    <SidebarPresentation width={measuredWidth} inset={compact ? 0 : spacingInset}>
      <Animated.View
        accessibilityElementsHidden={!active}
        importantForAccessibility={active ? "auto" : "no-hide-descendants"}
        pointerEvents={active ? "auto" : "none"}
        style={desktopSidebarStyle}
        onLayout={measureSidebar}
      >
        <View style={desktopSidebarBorderStyle} onLayout={onPanelLayout} testID="floating-sidebar">
          {compact ? (
            <>
              {ownsTopLeft ? (
                <View style={styles.desktopChromeRow}>
                  <TitlebarDragRegion />
                </View>
              ) : null}
              <CompactProjectRail
                header={toolbar}
                footer={railFooter}
                workspaceEntries={workspaceEntriesByKey}
                projects={projects}
                onSelectProject={selectRailProject}
              />
            </>
          ) : (
            <>
              <View style={styles.sidebarDragArea}>
                {ownsTopLeft || DEV_BUILD_LABEL ? (
                  <View style={styles.desktopChromeRow}>
                    <TitlebarDragRegion />
                    {devBadge}
                  </View>
                ) : (
                  <TitlebarDragRegion />
                )}
                {toolbar}
                {hasActiveProjectFilter ? (
                  <View style={styles.sidebarModeRow}>
                    <Button variant="ghost" size="xs" onPress={showAllProjects}>
                      All projects
                    </Button>
                  </View>
                ) : null}
              </View>

              {isInitialLoad && !hasActiveHostFilter ? (
                <>
                  {navigation}
                  <SidebarAgentListSkeleton />
                </>
              ) : (
                <SidebarWorkspaceList
                  collapsedProjectKeys={collapsedProjectKeys}
                  onToggleProjectCollapsed={toggleProjectCollapsed}
                  shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                  groupMode={groupMode}
                  workspaceGroups={workspaceGroups}
                  projectIconTargets={projectIconTargets}
                  pinnedGroups={pinnedGroups}
                  projects={projects}
                  hasProjectsBeforeFilter={hasProjectsBeforeFilter}
                  hasActiveProjectFilter={hasActiveProjectFilter}
                  workspaceEntriesByKey={workspaceEntriesByKey}
                  isRefreshing={isManualRefresh && isRevalidating}
                  onRefresh={handleRefresh}
                  onAddProject={handleOpenProject}
                  onImportSession={handleImportSession}
                  listTopComponent={navigation}
                  listHeaderComponent={undefined}
                />
              )}
            </>
          )}

          <InstallationRestartBanner placement={compact ? "rail" : "sidebar"} />
          {!compact ? <DemoControls /> : null}
          {!compact ? <SidebarFooterRows /> : null}

          <SidebarResizeHandle
            edge="right"
            floating
            onPointerDown={handlePointerResize}
            gesture={resizeGesture}
            pressed={resizePressed}
            testID="left-sidebar-resize-handle"
          />
        </View>
      </Animated.View>
    </SidebarPresentation>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (WorkspacesSectionHeader takes no props).

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
    margin: SIDEBAR_OUTER_GAP,
  },
  desktopSidebarHidden: {
    display: "none",
  },
});

const styles = StyleSheet.create((theme) => ({
  narrowNavigation: { gap: 2, padding: 2 },
  narrowNavigationRow: { justifyContent: "flex-start", minHeight: 36 },
  railToolbar: { alignItems: "center", gap: 2, paddingTop: 2 },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  sidebarModeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  themeMenu: { paddingHorizontal: 16, paddingVertical: 8 },
  sidebarToolbar: {
    gap: theme.spacing[2],
    height: VORTON_HEADER_HEIGHT,
    paddingTop: 0,
    paddingBottom: 0,
    borderTopWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: "transparent",
  },
  scrollingNavGroup: {
    gap: 2,
    paddingBottom: theme.spacing[1.5],
  },
  footerGap: { flex: 1 },
  footerIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  footerAddProjectButton: {
    minWidth: 0,
    minHeight: 32,
    width: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  // Buttons sit edge to edge; their own inset spaces the glyphs.
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  // Pushes Help and Settings to the end of the icon line.
  footerRows: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
  },
  footerIconButton: (isCompact: boolean) => ({
    width: isCompact ? buttonControlHeight.md : buttonControlHeight.xs,
    height: isCompact ? buttonControlHeight.md : buttonControlHeight.xs,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  }),
  touchIconButton: { width: 44, height: 44 },
  activeIconButton: {
    backgroundColor: theme.colors.interactionHighlight,
    borderRadius: theme.borderRadius.md,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));

function SidebarThemePicker() {
  const { selectItem } = useMenuContext("SidebarThemePicker");
  const selectTheme = useCallback((action: () => void) => selectItem(action, false), [selectItem]);
  return <ThemePreviewGrid compact selectTheme={selectTheme} />;
}
