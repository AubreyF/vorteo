import { WorkspaceMenuItems } from "@/components/sidebar/sidebar-workspace-menu";
import { WorkspaceRenameModal } from "@/components/workspace-rename-modal";
import { createSidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { useSidebarWorkspacePinController } from "@/hooks/use-sidebar-workspace-pin";
import { useHostFeature } from "@/runtime/host-features";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useWorkspaceMenuActions } from "@/workspace/use-workspace-menu-actions";
import { useWorkspaceSessionMenu } from "@/workspace/use-workspace-session-menu";
import { useWorkspaceLabelMenuPages } from "@/workspace-labels/picker";
import React, { createContext, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { EllipsisVertical, Globe, SquarePen } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { TerminalProfileIcon } from "@/components/terminal-profile-icon";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";

export const WorkspaceToolbarToggleContext = createContext<ReactNode>(null);

export const WorkspaceOverflowItemsContext = createContext<{
  items: ReactNode;
  pages: ReturnType<typeof useWorkspaceLabelMenuPages>;
} | null>(null);

interface WorkspaceMenuPresentation {
  children?: ReactNode;
  overflow?: boolean;
  enabled?: boolean;
}

/** Share actions and submenu pages with the existing pane menu, without another trigger. */
export function WorkspaceOverflowProvider(
  props: WorkspaceHeaderWorkspaceActions & WorkspaceMenuPresentation,
) {
  return <WorkspaceHeaderActionsMenu {...props} overflow />;
}

const ThemedEllipsis = withUnistyles(EllipsisVertical);
const ThemedSquarePen = withUnistyles(SquarePen);
const ThemedGlobe = withUnistyles(Globe);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MENU_NEW_AGENT_ICON = <ThemedSquarePen size={16} uniProps={mutedColorMapping} />;
const MENU_NEW_BROWSER_ICON = <ThemedGlobe size={16} uniProps={mutedColorMapping} />;
const MENU_NEW_TERMINAL_ICON = <TerminalProfileIcon iconKey={undefined} size={16} />;
function WorkspaceHeaderMenuTriggerIcon() {
  return (
    <ThemedEllipsis
      size={iconButtonChromeGlyphSize("large")}
      uniProps={extraMutedIconColorMapping}
    />
  );
}

/**
 * The compact header buttons draw at 32pt, under the 44pt touch minimum, and sit flush against
 * each other — so the slop can only grow vertically. Widening it would put two buttons' slop over
 * the same pixels, which is a worse miss than a small target.
 */
const COMPACT_HEADER_BUTTON_HIT_SLOP = { top: 8, bottom: 8 } as const;

export interface WorkspaceHeaderWorkspaceActions {
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}

function WorkspaceHeaderActionsMenu({
  normalizedServerId,
  normalizedWorkspaceId,
  children,
  overflow = false,
  enabled = true,
}: WorkspaceHeaderWorkspaceActions & WorkspaceMenuPresentation) {
  const descriptor = useWorkspace(normalizedServerId, normalizedWorkspaceId);
  const workspace = useMemo(
    () =>
      descriptor
        ? createSidebarWorkspaceEntry({ serverId: normalizedServerId, workspace: descriptor })
        : null,
    [descriptor, normalizedServerId],
  );
  if (!workspace)
    return overflow ? (
      <WorkspaceOverflowItemsContext.Provider value={null}>
        {children}
      </WorkspaceOverflowItemsContext.Provider>
    ) : null;
  return (
    <WorkspaceHeaderActionsMenuLoaded workspace={workspace} overflow={overflow} enabled={enabled}>
      {children}
    </WorkspaceHeaderActionsMenuLoaded>
  );
}

function WorkspaceHeaderActionsMenuLoaded({
  workspace,
  children,
  overflow,
  enabled,
}: WorkspaceMenuPresentation & {
  workspace: SidebarWorkspaceEntry;
}) {
  const { t } = useTranslation();
  const canPin = useHostFeature(workspace.serverId, "workspacePinning");
  const onToggleWorkspacePin = useSidebarWorkspacePinController();
  const actions = useWorkspaceMenuActions({
    workspace,
    selected: true,
    canPin,
    onToggleWorkspacePin,
  });
  const sessionMenu = useWorkspaceSessionMenu(workspace.serverId, workspace.workspaceId);
  const target = useMemo(
    () => ({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      labels: workspace.labels ?? [],
    }),
    [workspace.serverId, workspace.workspaceId, workspace.labels],
  );
  const pages = useWorkspaceLabelMenuPages(target);
  const items = useMemo(
    () => (
      <WorkspaceMenuItems
        surface="dropdown"
        testIDPrefix="workspace-header"
        workspaceKey={workspace.workspaceKey}
        serverId={workspace.serverId}
        workspaceId={workspace.workspaceId}
        onCopyPath={actions.handleCopyPath}
        onCopyBranchName={
          workspace.projectKind === "git" ? actions.handleCopyBranchName : undefined
        }
        onRename={actions.handleOpenRename}
        onMarkAsRead={actions.hasClearableAttention ? actions.handleMarkAsRead : undefined}
        onMarkAsUnread={actions.canMarkUnread ? actions.handleMarkAsUnread : undefined}
        onArchive={actions.handleArchive}
        archiveStatus={actions.isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        archiveShortcutKeys={actions.archiveShortcutKeys}
        isPinned={actions.isPinned}
        onTogglePin={actions.onTogglePin}
        openInFileManagerPath={workspace.workspaceDirectory}
        {...sessionMenu}
      />
    ),
    [actions, sessionMenu, t, workspace],
  );
  const sheets = (
    <>
      <WorkspaceRenameModal
        visible={actions.isRenameOpen}
        workspace={workspace}
        onClose={actions.handleCloseRename}
        testID="workspace-header-rename-modal"
      />
      {sessionMenu.sheet}
    </>
  );
  const overflowValue = useMemo(() => (enabled ? { items, pages } : null), [enabled, items, pages]);
  if (overflow) {
    return (
      <WorkspaceOverflowItemsContext.Provider value={overflowValue}>
        {children}
        {sheets}
      </WorkspaceOverflowItemsContext.Provider>
    );
  }
  return (
    <>
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          testID="workspace-header-menu-trigger"
          style={workspaceHeaderMenuButtonStyle}
          hitSlop={COMPACT_HEADER_BUTTON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.header.actions.workspaceActions")}
        >
          <WorkspaceHeaderMenuTriggerIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          width={260}
          testID="workspace-header-menu"
          pages={pages}
          sheetTitle={t("workspace.header.actions.workspaceActions")}
        >
          {items}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      {sheets}
    </>
  );
}

function workspaceHeaderMenuButtonStyle({
  hovered,
  pressed,
  open,
}: {
  hovered: boolean;
  pressed: boolean;
  open: boolean;
}) {
  return iconButtonChromeStyle({ size: "large", state: { hovered, pressed, open } });
}

/**
 * Wide layouts make tabs from the tab strip's `+` menu, so this one carries workspace actions only.
 */
export function WorkspaceHeaderMenuDesktop(props: WorkspaceHeaderWorkspaceActions) {
  return <WorkspaceHeaderActionsMenu {...props} />;
}

interface HeaderMenuProfileItemProps {
  profile: TerminalProfile;
  disabled: boolean;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
}

function HeaderMenuProfileItem({
  profile,
  disabled,
  onCreateTerminalWithProfile,
}: HeaderMenuProfileItemProps) {
  const handleSelect = useCallback(() => {
    onCreateTerminalWithProfile(profile);
  }, [onCreateTerminalWithProfile, profile]);

  const leading = useMemo(
    () => (
      <View style={styles.headerMenuProfileIconWrapper}>
        <TerminalProfileIcon iconKey={getTerminalProfileIcon(profile)} size={16} />
      </View>
    ),
    [profile],
  );

  return (
    <DropdownMenuItem leading={leading} disabled={disabled} onSelect={handleSelect}>
      {profile.name}
    </DropdownMenuItem>
  );
}

export interface WorkspaceHeaderMenuMobileProps extends WorkspaceHeaderWorkspaceActions {
  showCreateBrowserTab: boolean;
  createTerminalDisabled: boolean;
  onCreateDraftTab: () => void;
  onCreateTerminal: () => void;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
  onCreateBrowser: () => void;
}

/**
 * Compact layouts have no tab strip to launch from, so new tabs live here alongside the workspace
 * actions.
 */
export function WorkspaceHeaderMenuMobile({
  normalizedServerId,
  normalizedWorkspaceId,
  showCreateBrowserTab,
  createTerminalDisabled,
  onCreateDraftTab,
  onCreateTerminal,
  onCreateTerminalWithProfile,
  onCreateBrowser,
}: WorkspaceHeaderMenuMobileProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { config } = useDaemonConfig(normalizedServerId);
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );

  const handleEditProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(normalizedServerId, "terminals") as Href);
  }, [normalizedServerId, router]);

  return (
    <WorkspaceHeaderActionsMenu
      normalizedServerId={normalizedServerId}
      normalizedWorkspaceId={normalizedWorkspaceId}
    >
      <DropdownMenuSeparator />
      <DropdownMenuItem
        testID="workspace-header-new-agent"
        leading={MENU_NEW_AGENT_ICON}
        onSelect={onCreateDraftTab}
      >
        {t("workspace.header.actions.newAgent")}
      </DropdownMenuItem>
      {showCreateBrowserTab ? (
        <DropdownMenuItem
          testID="workspace-header-new-browser"
          leading={MENU_NEW_BROWSER_ICON}
          onSelect={onCreateBrowser}
        >
          {t("workspace.header.actions.newBrowser")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t("workspace.tabs.actions.terminalProfilesMenu")}</DropdownMenuLabel>
      <DropdownMenuItem
        testID="workspace-header-new-terminal"
        leading={MENU_NEW_TERMINAL_ICON}
        disabled={createTerminalDisabled}
        onSelect={onCreateTerminal}
      >
        {t("workspace.header.actions.newTerminal")}
      </DropdownMenuItem>
      {profiles.map((profile) => (
        <HeaderMenuProfileItem
          key={profile.id}
          profile={profile}
          disabled={createTerminalDisabled}
          onCreateTerminalWithProfile={onCreateTerminalWithProfile}
        />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        testID="workspace-header-edit-terminal-profiles"
        onSelect={handleEditProfiles}
      >
        {t("workspace.tabs.actions.editTerminalProfiles")}
      </DropdownMenuItem>
    </WorkspaceHeaderActionsMenu>
  );
}

const styles = StyleSheet.create({
  headerMenuProfileIconWrapper: {
    width: 16,
    height: 16,
  },
});
