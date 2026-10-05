import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useOpenNewWorkspace } from "@/hooks/use-open-new-workspace";
import { useVortonTouch } from "@/vorton-touch";
import { useVortonMode } from "@/vorton-mode";
import { router, usePathname } from "expo-router";
import { useVortonCompatibilityCallout } from "./vorton-compatibility-callout";
import {
  CircleGauge,
  Search,
  FolderPlus,
  Plus,
  History,
  CalendarClock,
  Settings2,
  GitBranch,
  Import,
  Server,
  Settings,
  X,
  MoreHorizontal,
  CircleHelp,
} from "lucide-react-native";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { HostPicker } from "@/components/hosts/host-picker";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
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
import { useHosts } from "@/runtime/host-runtime";
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
import { UsageSidebarItem, useHasUsageSummary, useOpenUsageScreen } from "@/usage";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

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

export const LeftSidebar = memo(function LeftSidebar({ active }: { active: boolean }) {
  useVortonCompatibilityCallout();
  const { theme } = useUnistyles();
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

function sidebarHostOptionTestID(serverId: string): string {
  return `sidebar-host-row-${serverId}`;
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
            touch && styles.touchIconButton,
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

function SidebarHostPicker({
  theme,
  label,
  onAddHost,
  onOpenHostSettings,
  hiddenTrigger = false,
  controlledOpen,
  onOpenChange,
}: {
  hiddenTrigger?: boolean;
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  theme: SidebarTheme;
  label: string;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}) {
  const hosts = useHosts();
  const triggerRef = useRef<View | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = controlledOpen ?? localOpen;
  const setIsOpen = onOpenChange ?? setLocalOpen;

  const handleSelect = useCallback(
    (id: string) => {
      onOpenHostSettings(id);
    },
    [onOpenHostSettings],
  );

  const handleOpen = useCallback(() => setIsOpen(true), [setIsOpen]);

  return (
    <HostPicker
      hosts={hosts}
      value=""
      onSelect={handleSelect}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      showActiveConnection
      onOpenHostSettings={onOpenHostSettings}
      searchable
      desktopPlacement="top-start"
      desktopMinWidth={240}
      addHostTestID="sidebar-host-add"
      hostOptionTestID={sidebarHostOptionTestID}
    >
      <View style={hiddenTrigger ? styles.hiddenFooterTrigger : undefined}>
        <FooterIconButton
          buttonRef={triggerRef}
          disabled={hiddenTrigger}
          onPress={handleOpen}
          testID="sidebar-hosts-trigger"
          label={label}
          icon={Server}
          iconSizeAdjustment={-1}
          theme={theme}
        />
      </View>
    </HostPicker>
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
  handleImportSession,
  theme,
  handleOpenProject,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  onBeforeNavigate,
}: {
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
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");
  const searchKeys = useShortcutKeys("toggle-command-center");
  const alternateSearchKeys = useShortcutKeys("toggle-command-center-alternate");
  const { t } = useTranslation();
  const [hostsOpen, setHostsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const vorton = useVortonMode();
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
      project: <FolderPlus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      help: <CircleHelp size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      workspace: <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      display: <Settings2 size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    }),
    [theme.iconSize.sm, theme.colors.foregroundMuted],
  );
  return (
    <View style={[styles.sidebarFooter, vorton && styles.sidebarToolbar]} testID="sidebar-toolbar">
      {vorton && (
        <FooterIconButton
          icon={Search}
          onPress={handleSearch}
          label={t("sidebar.sections.search")}
          shortcutKeys={searchKeys}
          alternateShortcutKeys={alternateSearchKeys}
          testID="sidebar-search"
          theme={theme}
        />
      )}
      <View style={styles.footerGap} />
      <View style={styles.footerIconRow}>
        {vorton && (
          <View>
            <SidebarHelpMenu hiddenTrigger controlledOpen={helpOpen} onOpenChange={setHelpOpen} />
            <SidebarDisplayPreferencesMenu
              hiddenTrigger
              controlledOpen={displayOpen}
              onOpenChange={setDisplayOpen}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                style={[styles.footerIconButton(false), touch && styles.touchIconButton]}
                accessibilityLabel="More sidebar actions"
                accessibilityRole="button"
                testID="sidebar-footer-overflow"
              >
                <MoreHorizontal size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" width={240}>
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
                <DropdownMenuItem
                  testID="sidebar-display-preferences-action"
                  onSelect={openDisplay}
                  leading={menuIcons.display}
                >
                  {t("sidebar.display.viewPreferences")}
                </DropdownMenuItem>
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
        )}
        {!vorton && (
          <FooterIconButton
            testID="sidebar-add-project"
            icon={FolderPlus}
            onPress={handleOpenProject}
            label={labels.addProject}
            shortcutKeys={newAgentKeys}
            theme={theme}
          />
        )}
        {vorton && (
          <>
            <FooterIconButton
              testID="sidebar-sessions"
              icon={History}
              onPress={openHistory}
              active={pathname.includes("/sessions")}
              label={t(builtinSidebarNavLabelKey("history"))}
              theme={theme}
            />
            <FooterIconButton
              testID="sidebar-schedules"
              icon={CalendarClock}
              onPress={openSchedules}
              active={pathname.includes("/schedules")}
              label={t(builtinSidebarNavLabelKey("schedules"))}
              theme={theme}
            />
          </>
        )}
        {!vorton && (
          <SidebarHostPicker
            controlledOpen={hostsOpen}
            onOpenChange={setHostsOpen}
            theme={theme}
            label={labels.hosts}
            onAddHost={handleAddHost}
            onOpenHostSettings={handleOpenHostSettings}
          />
        )}
        {!vorton ? (
          <FooterIconButton
            onPress={handleImportSession}
            testID="sidebar-import-session"
            label={labels.importSession}
            icon={Import}
            theme={theme}
          />
        ) : null}
        {!vorton && <SidebarHelpMenu />}
        <FooterIconButton
          onPress={handleSettings}
          testID="sidebar-settings"
          label={labels.settings}
          icon={Settings}
          shortcutKeys={settingsKeys}
          theme={theme}
        />
      </View>
    </View>
  );
}

/**
 * The footer rows in the user's `sidebarFooterItems` order: the Usage item and plugin rows. The
 * Usage item is left out while it has no summary to show.
 */
function SidebarFooter({
  theme,
  handleOpenProject,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  onBeforeNavigate,
}: {
  theme: SidebarTheme;
  handleOpenProject: () => void;
  handleSettings: () => void;
  labels: {
    addProject: string;
    hosts: string;
    settings: string;
    searchHosts: string;
    usage: string;
  };
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
  onBeforeNavigate?: () => void;
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");
  const openUsageScreen = useOpenUsageScreen();

  // One line of icons: Add project, Usage, Hosts, then Help and Settings at the end.
  return (
    <View style={styles.footerContainer} testID="sidebar-footer">
      <SidebarFooterRows onBeforeNavigate={onBeforeNavigate} />
      <View style={styles.sidebarFooter} testID="sidebar-footer-bottom-line">
        <FooterIconButton
          onPress={handleOpenProject}
          testID="sidebar-add-project"
          label={labels.addProject}
          icon={FolderPlus}
          shortcutKeys={newAgentKeys}
          theme={theme}
        />
        <FooterIconButton
          onPress={openUsageScreen}
          testID="sidebar-usage-icon"
          label={labels.usage}
          icon={CircleGauge}
          theme={theme}
        />
        <SidebarHostPicker
          theme={theme}
          label={labels.hosts}
          onAddHost={handleAddHost}
          onOpenHostSettings={handleOpenHostSettings}
        />
        <View style={styles.footerSpacer} />
        <SidebarHelpMenu />
        <FooterIconButton
          onPress={handleSettings}
          testID="sidebar-settings"
          label={labels.settings}
          icon={Settings}
          shortcutKeys={settingsKeys}
          theme={theme}
        />
      </View>
    </View>
  );
}

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
  const vorton = useVortonMode();
  const touch = useVortonTouch();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

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

  const navigation = (
    <View>
      <SidebarNavRows
        style={vorton ? styles.scrollingNavGroup : styles.sidebarHeaderGroup}
        onBeforeNavigate={closeSidebar}
      />
      {!vorton && (
        <WindowChromeSafeArea
          placement="inline"
          pointerEvents="box-none"
          style={styles.mobileCloseButtonRow}
        >
          <Pressable
            style={styles.mobileCloseButton}
            onPress={closeSidebar}
            testID="sidebar-close"
            nativeID="sidebar-close"
            accessible
            accessibilityRole="button"
            accessibilityLabel={labels.closeSidebar}
            hitSlop={8}
          >
            {({ hovered, pressed }) => (
              <X
                size={theme.iconSize.md}
                color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </WindowChromeSafeArea>
      )}
    </View>
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
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowChromeSafeArea placement="below" />
        {vorton && toolbar}
        {!vorton && navigation}

        {isInitialLoad && !hasActiveHostFilter ? (
          <>
            {vorton && navigation}
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
            listTopComponent={vorton ? navigation : undefined}
            listHeaderComponent={vorton ? undefined : workspacesSectionHeaderElement}
          />
        )}

        {vorton ? (
          <SidebarFooterRows onBeforeNavigate={closeSidebar} />
        ) : (
          <SidebarFooter
            theme={theme}
            handleOpenProject={handleOpenProject}
            handleSettings={handleSettings}
            labels={labels}
            handleAddHost={handleAddHost}
            handleOpenHostSettings={handleOpenHostSettings}
            onBeforeNavigate={closeSidebar}
          />
        )}
      </View>
    </MobilePanelOverlay>
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
  const vorton = useVortonMode();
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
  });

  const startWidthRef = useRef(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

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
  const desktopSidebarBorderStyle = useMemo(
    () => [styles.desktopSidebarBorder, { flex: 1, paddingTop: insetsTop }],
    [insetsTop],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [styles.sidebarHeaderGroup, ownsTopLeft && styles.sidebarHeaderGroupBelowChrome],
    [ownsTopLeft],
  );
  const navigation = <SidebarNavRows style={styles.scrollingNavGroup} />;
  const toolbar = (
    <SidebarToolbar
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
    <Animated.View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={desktopSidebarStyle}
    >
      <View style={desktopSidebarBorderStyle}>
        <View style={styles.sidebarDragArea}>
          {ownsTopLeft || DEV_BUILD_LABEL ? (
            <View style={styles.desktopChromeRow}>
              <TitlebarDragRegion />
              {DEV_BUILD_LABEL ? (
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
              ) : null}
            </View>
          ) : (
            <TitlebarDragRegion />
          )}
          {vorton && toolbar}
          {!vorton && <SidebarNavRows style={sidebarHeaderGroupStyle} />}
        </View>

        {isInitialLoad && !hasActiveHostFilter ? (
          <>
            {vorton && navigation}
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
            listTopComponent={vorton ? navigation : undefined}
            listHeaderComponent={vorton ? undefined : workspacesSectionHeaderElement}
          />
        )}

        <SidebarCalloutSlot />

        {vorton ? (
          <SidebarFooterRows />
        ) : (
          <SidebarFooter
            theme={theme}
            handleOpenProject={handleOpenProject}
            handleSettings={handleSettings}
            labels={labels}
            handleAddHost={handleAddHost}
            handleOpenHostSettings={handleOpenHostSettings}
          />
        )}

        <SidebarResizeHandle
          edge="right"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="left-sidebar-resize-handle"
        />
      </View>
    </Animated.View>
  );
}

function WorkspacesSectionHeader() {
  return (
    <View style={styles.workspacesSectionHeader}>
      <Text style={styles.workspacesSectionTitle}>Workspaces</Text>
      <View style={styles.workspacesSectionActions}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <View>
              <SidebarDisplayPreferencesMenu />
            </View>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <IconTooltipContent label="Display preferences" />
          </TooltipContent>
        </Tooltip>
      </View>
    </View>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (WorkspacesSectionHeader takes no props).
const workspacesSectionHeaderElement = <WorkspacesSectionHeader />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
  desktopSidebarHidden: {
    display: "none",
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sidebarHeaderGroupBelowChrome: {
    paddingTop: 0,
  },
  workspacesSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    // Rendered inside the scroll's listContent (paddingHorizontal spacing[2]). The title
    // lands at spacing[2] left to align with project icons. Settings2's painted path stops
    // inside its 14px SVG, so 4px aligns the ink rather than the SVG box to the row rail.
    paddingLeft: theme.spacing[2],
    paddingRight: 4,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  workspacesSectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  workspacesSectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButtonRow: {
    position: "absolute",
    top: theme.spacing[3],
    left: 0,
    right: 0,
    zIndex: 2,
    alignItems: "flex-end",
  },
  mobileCloseButton: {
    // The 16px X paints farther inside its 32px hit target than the 14px Settings2 glyph.
    // This optical inset puts their painted right edges on the same sidebar rail.
    marginRight: theme.spacing[2] + 1.5,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
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
  footerContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  sidebarToolbar: {
    gap: theme.spacing[2],
    height: VORTON_HEADER_HEIGHT,
    paddingTop: 0,
    paddingBottom: 0,
    borderTopWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  scrollingNavGroup: {
    gap: 2,
    paddingBottom: theme.spacing[1.5],
  },
  footerGap: { flex: 1 },
  hiddenFooterTrigger: {
    position: "absolute",
    width: 0,
    height: 0,
    overflow: "hidden",
    opacity: 0,
  },
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
  footerSpacer: {
    flex: 1,
  },
  // Usage and plugin rows sit above the footer's icon line, spaced like the header nav rows.
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
