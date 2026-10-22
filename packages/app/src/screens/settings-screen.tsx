import { InstallationConnectionCheck } from "@/execution-installation/connection-check-wrapper";
import { InstallationRestartBanner, InstallationControls } from "@/execution-installation/panel";
import { SystemProjectCard } from "@/execution-installation/system-project-card";
import { ActionFooter } from "@/components/ui/action-footer";
import { WorkspaceDefaultsSection } from "@/screens/settings/general/workspace-defaults-section";
import { AttentionSection } from "@/screens/settings/general/attention-section";
import { EnvironmentsPane } from "./settings/environments-page";
import { SkillLibraryContent } from "@/agent-skills/library";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import { usePanelStore } from "@/stores/panel-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useWindowDimensions } from "@/appearance/interface-geometry";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Buffer } from "buffer";
import {
  ArrowLeft,
  Settings,
  Palette,
  Server,
  Bot,
  Info,
  MessageSquare,
  Plus,
  FolderGit2,
  SquareTerminal,
  Sparkles,
  Blocks,
  Wrench,
  ChevronRight,
} from "lucide-react-native";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import { OpenLocationSection } from "@/screens/settings/open-location/open-location-section";
import { TerminalSection } from "@/screens/settings/terminal/terminal-section";
import { ChatSection } from "@/screens/settings/chat/chat-section";
import { SendingSection } from "@/screens/settings/general/sending-section";
import {
  useAppSettings,
  useSettings,
  type AppSettings,
  type Settings as EffectiveSettings,
} from "@/hooks/use-settings";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { type HostProfile } from "@/types/host-connection";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { PageLayout } from "@/components/page-layout";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { AddRemoteSshHostModal } from "@/components/add-remote-ssh-host-modal";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { EditorSection } from "@/screens/settings/editor-section";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CommunityLinks } from "@/components/community-links";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { isElectronRuntime } from "@/desktop/host";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { UpstreamUpdatesSection } from "@/vorton-updates/upstream-section";
import { VortonUpdatesSection } from "@/vorton-updates/section";
import { resolveAppVersion } from "@/utils/app-version";
import { useVortonUpdate } from "@/vorton-updates/use-update";
import { openChangelog } from "@/changelog";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { settingsStyles } from "@/styles/settings";
import { floatingPanelStyles, FLOATING_PANEL_INSET } from "@/styles/floating-panel";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";
import { toErrorMessage } from "@/utils/error-messages";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  type AppLanguage,
  type SupportedLocale,
} from "@/i18n/locales";
import {
  HostConnectionsPage,
  HostPairDevicePage,
  HostAgentsPage,
  HostSettingsPage,
  HostProvidersPage,
  HostUsagePage,
  HostWorkspacesPage,
  HostTerminalsPage,
} from "@/screens/settings/host-page";
import { PluginSettingsContent } from "@/plugins/settings";
import { useInstalledPlugins } from "@/plugins/registry";
import { HostPluginsPage } from "@/screens/settings/plugins-page";
import { MetadataGenerationPage } from "@/screens/settings/metadata-generation-page";
import ProjectsScreen from "@/screens/projects-screen";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import {
  SETTINGS_DESKTOP_SIDEBAR_WIDTH,
  VORTON_HEADER_HEIGHT,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useEnableBuiltInDaemonOption } from "@/desktop/hooks/use-enable-built-in-daemon-option";
import {
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
} from "@/utils/host-routes";
import { returnFromSettings, type SettingsView } from "@/navigation/settings-navigation";
import { isNative, isWeb } from "@/constants/platform";
import { InstallationSettingsContent } from "@/screens/settings/installation-sections";
import { readExecutionInstallation } from "@/execution-installation/policy";
import {
  SETTINGS_ENTRIES,
  SETTINGS_SECTIONS,
  getPane,
  getSection,
  isAvailable,
  panesForSection,
  resolveSettingsTarget,
  type SettingsAvailabilityContext,
  type SettingsSectionId,
} from "@/settings-catalog/catalog";
import {
  SettingsScrollPage,
  SettingsSearchBox,
  type ResolvedSettingsEntry,
  type SettingsPageSection,
  type SettingsSearchControls,
} from "@/screens/settings/settings-scroll-page";
import { useSettingsNavigation } from "@/screens/settings/use-settings-navigation";
import { useSettingsSearchShortcut } from "@/screens/settings/use-settings-search-shortcut";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

type IconComponent = ComponentType<{ size: number; color: string; strokeWidth?: number }>;

const SECTION_ICONS: Record<SettingsSectionId, IconComponent> = {
  general: Settings,
  accounts: Bot,
  agents: Sparkles,
  chat: MessageSquare,
  terminal: SquareTerminal,
  appearance: Palette,
  workspaces: FolderGit2,
  environments: Server,
  plugins: Blocks,
  maintenance: Wrench,
  about: Info,
};

interface HostSectionItem {
  id: HostSectionSlug;
  labelKey: string;
}

/** Titles for the per-host drill-in pages under `/settings/hosts/<id>/<section>`. */
const HOST_SECTION_ITEMS: HostSectionItem[] = [
  { id: "host", labelKey: "settings.hostSections.host" },
  { id: "providers", labelKey: "settings.hostSections.providers" },
  { id: "projects", labelKey: "settings.hostSections.projects" },
  { id: "connections", labelKey: "settings.hostSections.connections" },
  { id: "agents", labelKey: "settings.hostSections.agents" },
  { id: "metadata", labelKey: "settings.hostSections.metadata" },
  { id: "workspaces", labelKey: "settings.hostSections.workspaces" },
  { id: "usage", labelKey: "settings.hostSections.usage" },
  { id: "terminals", labelKey: "settings.hostSections.terminals" },
  { id: "plugins", labelKey: "settings.hostSections.plugins" },
];

/** The section a drill-in page belongs to, for the sidebar highlight. */
function sectionForView(view: SettingsView): SettingsSectionId | null {
  if (view.kind === "project") return "workspaces";
  if (view.kind === "plugin") return "plugins";
  if (view.kind === "host") {
    if (view.section === "host") return "environments";
    return resolveSettingsTarget(view.section).section;
  }
  return null;
}

/** The sidebar highlight: none while searching, else the section in view or owning a drill-in. */
function selectedSidebarSection(
  view: SettingsView,
  searching: boolean,
  activeSection: SettingsSectionId,
): SettingsSectionId | null {
  if (searching) return null;
  return view.kind === "section" ? activeSection : sectionForView(view);
}

function renderHostSettingsContent(
  view: Extract<SettingsView, { kind: "host" }>,
  onHostRemoved: () => void,
): ReactNode {
  switch (view.section) {
    case "projects":
      return <ProjectsScreen serverId={view.serverId} />;
    case "connections":
      return <HostConnectionsPage serverId={view.serverId} />;
    case "pair-device":
      return <HostPairDevicePage serverId={view.serverId} />;
    case "agents":
      return <HostAgentsPage serverId={view.serverId} />;
    case "metadata":
      return <MetadataGenerationPage serverId={view.serverId} />;
    case "workspaces":
      return <HostWorkspacesPage serverId={view.serverId} />;
    case "providers":
      return <HostProvidersPage serverId={view.serverId} />;
    case "usage":
      return <HostUsagePage serverId={view.serverId} />;
    case "terminals":
      return <HostTerminalsPage serverId={view.serverId} />;
    case "plugins":
      return <HostPluginsPage serverId={view.serverId} />;
    case "host":
      return <HostSettingsPage serverId={view.serverId} onHostRemoved={onHostRemoved} />;
  }
}

function useAvailabilityContext(): SettingsAvailabilityContext {
  const hosts = useHosts();
  const isDesktopApp = isElectronRuntime();
  const hasInstallation = readExecutionInstallation() !== null;
  return useMemo(
    () => ({ isDesktopApp, isWeb, isNative, hasHosts: hosts.length > 0, hasInstallation }),
    [hasInstallation, hosts.length, isDesktopApp],
  );
}

function useSettingsSections(context: SettingsAvailabilityContext): SettingsPageSection[] {
  return useMemo(
    () =>
      SETTINGS_SECTIONS.map((section) => ({
        id: section.id,
        label: section.label,
        panes: panesForSection(section.id, context),
      })).filter((section) => section.panes.length > 0),
    [context],
  );
}

/** Catalog entries for this device, translated, plus live names such as environments. */
function useSearchEntries(
  sections: readonly SettingsPageSection[],
  context: SettingsAvailabilityContext,
): ResolvedSettingsEntry[] {
  const { t } = useTranslation();
  const hosts = useHosts();
  return useMemo(() => {
    const available = new Set(sections.flatMap((section) => section.panes.map((pane) => pane.id)));
    const breadcrumbFor = (paneId: string) => {
      const pane = getPane(paneId);
      const section = pane ? getSection(pane.section) : null;
      return section && pane && section.label !== pane.label
        ? `${section.label} › ${pane.label}`
        : (section?.label ?? "");
    };
    const contextFor = (paneId: string) => {
      const pane = getPane(paneId);
      if (!pane) return [];
      const section = getSection(pane.section);
      // Section keywords stay out: they describe the whole section, and would
      // match every row in it. Section matches come from the pane filter.
      return [pane.label, section.label, ...(pane.keywords ?? [])];
    };
    const entries: ResolvedSettingsEntry[] = SETTINGS_ENTRIES.filter(
      (entry) => available.has(entry.pane) && isAvailable(entry, context),
    ).map((entry) => {
      const label = entry.labelKey ? t(entry.labelKey, { defaultValue: entry.label }) : entry.label;
      return {
        id: entry.id,
        pane: entry.pane,
        section: getPane(entry.pane)!.section,
        label,
        hint: entry.hintKey ? t(entry.hintKey, { defaultValue: entry.hint }) : entry.hint,
        // Keep the English label searchable when the interface is translated.
        keywords: label === entry.label ? entry.keywords : [entry.label, ...(entry.keywords ?? [])],
        context: contextFor(entry.pane),
        scope: entry.scope,
        breadcrumb: breadcrumbFor(entry.pane),
      };
    });
    if (available.has("environments.environments")) {
      for (const host of hosts) {
        entries.push({
          id: `environment:${host.serverId}`,
          pane: "environments.environments",
          section: "environments",
          label: host.label,
          keywords: ["environment", "host", host.serverId],
          context: contextFor("environments.environments"),
          scope: "device",
          breadcrumb: breadcrumbFor("environments.environments"),
        });
      }
    }
    return entries;
  }, [context, hosts, sections, t]);
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

function sidebarItemStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [sidebarStyles.item, Boolean(hovered) && sidebarStyles.itemHovered];
}

function selectedSidebarItemStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    sidebarStyles.itemSelected,
  ];
}

function getActiveLocale(language: string | undefined): SupportedLocale {
  const parsed = parseAppLanguage(language);
  return parsed && parsed !== "system" ? parsed : "en";
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

interface LanguageSectionProps {
  settings: AppSettings;
  handleLanguageChange: (language: AppLanguage) => void;
}

interface LanguageMenuItemProps {
  value: AppLanguage;
  activeLocale: SupportedLocale;
  selected: boolean;
  onChange: (value: AppLanguage) => void;
}

function LanguageMenuItem({ value, activeLocale, selected, onChange }: LanguageMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  const option = LANGUAGE_OPTIONS.find((entry) => entry.value === value);
  const label = option
    ? formatLanguageOptionLabel(option, activeLocale, t(option.labelKey))
    : value;

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function LanguageSection({ settings, handleLanguageChange }: LanguageSectionProps) {
  const { t, i18n } = useTranslation();
  const activeLocale = getActiveLocale(i18n.language);
  const selectedLanguageOption = LANGUAGE_OPTIONS.find(
    (option) => option.value === settings.language,
  );
  const selectedLanguageLabel = selectedLanguageOption
    ? formatLanguageOptionLabel(
        selectedLanguageOption,
        activeLocale,
        t(selectedLanguageOption.labelKey),
      )
    : settings.language;
  return (
    <SettingsSection title={t("settings.general.language.label")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.language.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.general.language.description")}</Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger accessibilityRole="button" accessibilityLabel={selectedLanguageLabel}>
              {selectedLanguageLabel}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={300}>
              {LANGUAGE_OPTIONS.map((option) => (
                <LanguageMenuItem
                  key={option.value}
                  value={option.value}
                  activeLocale={activeLocale}
                  selected={settings.language === option.value}
                  onChange={handleLanguageChange}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </SettingsSection>
  );
}

interface DiagnosticsSectionProps {
  useLegacyTerminalRenderer: boolean;
  onUseLegacyTerminalRendererChange: (value: boolean) => void;
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  handlePlaybackTest: () => Promise<void>;
}

function DiagnosticsSection({
  useLegacyTerminalRenderer,
  onUseLegacyTerminalRendererChange,
  voiceAudioEngine,
  isPlaybackTestRunning,
  playbackTestResult,
  handlePlaybackTest,
}: DiagnosticsSectionProps) {
  const { t } = useTranslation();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const handlePlayPress = useCallback(() => {
    void handlePlaybackTest();
  }, [handlePlaybackTest]);
  return (
    <SettingsSection title={t("settings.diagnostics.title")}>
      <View style={settingsStyles.card}>
        {isNative ? (
          <View style={settingsStyles.row} testID="legacy-terminal-renderer-row">
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.diagnostics.legacyTerminalRenderer.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.diagnostics.legacyTerminalRenderer.description")}
              </Text>
            </View>
            <Switch
              value={useLegacyTerminalRenderer}
              onValueChange={onUseLegacyTerminalRendererChange}
              accessibilityLabel={t(
                "settings.diagnostics.legacyTerminalRenderer.accessibilityLabel",
              )}
              testID="legacy-terminal-renderer-switch"
            />
          </View>
        ) : null}
        <View style={settingsStyles.row} testID="app-diagnostic-row">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.app.rowTitle")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.diagnostics.app.rowHint")}</Text>
          </View>
          <Button variant="secondary" size="sm" onPress={openAppDiagnostic}>
            {t("settings.diagnostics.app.run")}
          </Button>
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.testAudio")}</Text>
            {playbackTestResult ? (
              <Text style={settingsStyles.rowHint}>{playbackTestResult}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={handlePlayPress}
            disabled={!voiceAudioEngine || isPlaybackTestRunning}
          >
            {isPlaybackTestRunning
              ? t("settings.diagnostics.playing")
              : t("settings.diagnostics.playTest")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

interface AboutSectionProps {
  appVersionText: string;
  isDesktopApp: boolean;
}

function AboutSection({ appVersionText, isDesktopApp }: AboutSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <SettingsSection title={t("settings.about.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.about.appVersion")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.about.thisDevice")}</Text>
            </View>
            <Text style={styles.aboutValue}>{appVersionText}</Text>
          </View>
          <WhatsNewRow />
          {isDesktopApp ? <DesktopAppUpdateRow /> : null}
        </View>
      </SettingsSection>
      <View style={styles.aboutCommunity}>
        <CommunityLinks />
      </View>
    </>
  );
}

function WhatsNewRow() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();

  return (
    <Pressable
      style={[settingsStyles.row, settingsStyles.rowBorder]}
      onPress={openChangelog}
      accessibilityRole="button"
      testID="settings-whats-new"
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("changelog.title")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.about.whatsNewHint")}</Text>
          </View>
          <ChevronRight
            size={theme.iconSize.sm}
            color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
        </>
      )}
    </Pressable>
  );
}

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function ConnectedHostsSection({ clientVersion }: { clientVersion: string | null }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  if (hosts.length === 0) {
    return null;
  }
  return (
    <SettingsSection title={t("settings.about.connectedHosts")}>
      <View style={settingsStyles.card}>
        {hosts.map((host, index) => (
          <HostVersionRow
            key={host.serverId}
            host={host}
            showBorder={index > 0}
            clientVersion={clientVersion}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function HostVersionRow({
  host,
  showBorder,
  clientVersion,
}: {
  host: HostProfile;
  showBorder: boolean;
  clientVersion: string | null;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );

  const normalizedHost = normalizeVersion(daemonVersion);
  const normalizedClient = normalizeVersion(clientVersion);
  const isMismatch =
    normalizedHost !== null && normalizedClient !== null && normalizedHost !== normalizedClient;

  let valueText: string;
  if (!isConnected) {
    valueText = t("settings.about.offline");
  } else if (normalizedHost) {
    valueText = formatVersionWithPrefix(normalizedHost);
  } else {
    valueText = "—";
  }

  const valueStyle = useMemo(
    () => [styles.aboutValue, isMismatch && styles.aboutVersionMismatch],
    [isMismatch],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {host.label}
        </Text>
        {isMismatch ? (
          <Text style={settingsStyles.rowHint}>{t("settings.about.versionDiffers")}</Text>
        ) : null}
      </View>
      <Text style={valueStyle}>{valueText}</Text>
    </View>
  );
}

function getUpdateButtonLabel(
  t: TFunction,
  isInstalling: boolean,
  latestVersion: string | null | undefined,
): string {
  if (isInstalling) return t("settings.about.updates.installing");
  if (latestVersion) {
    return t("settings.about.updates.updateTo", {
      version: formatVersionWithPrefix(latestVersion),
    });
  }
  return t("settings.about.updates.update");
}

function DesktopAppUpdateRow() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();
  const {
    isDesktopApp,
    statusText,
    availableUpdate,
    errorMessage,
    isChecking,
    isInstalling,
    checkForUpdates,
    installUpdate,
  } = useDesktopAppUpdater();

  useFocusEffect(
    useCallback(() => {
      if (!isDesktopApp) {
        return undefined;
      }
      void checkForUpdates({ intent: "automatic", silent: true });
      return undefined;
    }, [checkForUpdates, isDesktopApp]),
  );

  const handleCheckForUpdates = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }
    void checkForUpdates();
  }, [checkForUpdates, isDesktopApp]);

  const handleReleaseChannelChange = useCallback(
    (releaseChannel: EffectiveSettings["releaseChannel"]) => {
      void updateSettings({ releaseChannel });
    },
    [updateSettings],
  );
  const releaseChannelOptions = useMemo(
    () => [
      { value: "stable" as const, label: t("settings.about.releaseChannel.stable") },
      { value: "beta" as const, label: t("settings.about.releaseChannel.beta") },
    ],
    [t],
  );

  const handleInstallUpdate = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }

    void confirmDialog({
      title: t("settings.about.updates.installTitle"),
      message: t("settings.about.updates.installMessage"),
      confirmLabel: t("settings.about.updates.installConfirm"),
      cancelLabel: t("common.actions.cancel"),
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        void installUpdate();
        return;
      })
      .catch((error) => {
        console.error("[Settings] Failed to open app update confirmation", error);
        Alert.alert(
          t("settings.about.updates.alertTitle"),
          t("settings.about.updates.alertMessage"),
        );
      });
  }, [installUpdate, isDesktopApp, t]);

  const isUpdateReady = availableUpdate?.readyToInstall === true;
  const readyUpdateVersion = isUpdateReady ? availableUpdate?.latestVersion : null;

  if (!isDesktopApp) {
    return null;
  }

  return (
    <>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.about.releaseChannel.label")}</Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.about.releaseChannel.description")}
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          value={settings.releaseChannel}
          onValueChange={handleReleaseChannelChange}
          options={releaseChannelOptions}
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.about.updates.label")}</Text>
          <Text style={settingsStyles.rowHint}>{statusText}</Text>
          {readyUpdateVersion ? (
            <Text style={settingsStyles.rowHint}>
              {t("settings.about.updates.readyToInstall", {
                version: formatVersionWithPrefix(readyUpdateVersion),
              })}
            </Text>
          ) : null}
          {errorMessage ? <Text style={styles.aboutErrorText}>{errorMessage}</Text> : null}
        </View>
        <ActionFooter style={styles.aboutUpdateActions}>
          <Button
            variant="outline"
            size="sm"
            onPress={handleCheckForUpdates}
            disabled={isChecking || isInstalling}
          >
            {isChecking ? t("settings.about.updates.checking") : t("settings.about.updates.check")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleInstallUpdate}
            disabled={isChecking || isInstalling || !isUpdateReady}
          >
            {getUpdateButtonLabel(t, isInstalling, readyUpdateVersion)}
          </Button>
        </ActionFooter>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface SidebarSectionButtonProps {
  sectionId: SettingsSectionId;
  label: string;
  icon: IconComponent;
  isSelected: boolean;
  onSelect: (section: SettingsSectionId) => void;
}

// Lighter than lucide's default 2px stroke so the nav reads quieter than the content.
const SIDEBAR_ICON_STROKE_WIDTH = 1.5;

function SidebarSectionButton({
  sectionId,
  label,
  icon: Icon,
  isSelected,
  onSelect,
}: SidebarSectionButtonProps) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(sectionId);
  }, [onSelect, sectionId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      testID={`settings-section-${sectionId}`}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <Icon
        size={theme.iconSize.md}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface SettingsSidebarProps {
  appVersionText: string;
  sections: readonly SettingsPageSection[];
  selectedSection: SettingsSectionId | null;
  onSelectSection: (section: SettingsSectionId) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  search: SettingsSearchControls;
  layout: "desktop" | "mobile";
}

function SettingsSidebar({
  appVersionText,
  sections,
  selectedSection,
  onSelectSection,
  onAddHost,
  onBackToWorkspace,
  search,
  layout,
}: SettingsSidebarProps) {
  const { checkNow } = useVortonUpdate();
  // The version footer checks for updates and shows the result where update
  // status lives, in Maintenance.
  const openUpdates = useCallback(() => {
    checkNow();
    onSelectSection("maintenance");
  }, [onSelectSection, checkNow]);
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const hasHosts = hosts.length > 0;
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  const insets = useSafeAreaInsets();
  const isDesktop = layout === "desktop";
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
  });
  const outerContainerStyle = useMemo(
    () => [
      floatingPanelStyles.surface,
      sidebarStyles.floatingContainer,
      isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer,
      isDesktop && { width: visibleSidebarWidth - FLOATING_PANEL_INSET * 2 },
    ],
    [isDesktop, visibleSidebarWidth],
  );
  const innerContainerStyle = useMemo(
    () => [{ flex: 1 }, isDesktop ? { paddingTop: insets.top } : null],
    [insets.top, isDesktop],
  );

  const sidebarBody = (
    <View style={sidebarStyles.list}>
      {sections.map((section) => (
        <SidebarSectionButton
          key={section.id}
          sectionId={section.id}
          label={section.label}
          icon={SECTION_ICONS[section.id]}
          isSelected={selectedSection === section.id}
          onSelect={onSelectSection}
        />
      ))}
      {hasHosts ? null : (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.addHost")}
            onPress={onAddHost}
            testID="settings-add-host"
            style={sidebarItemStyle}
          >
            <Plus
              size={theme.iconSize.md}
              color={theme.colors.foregroundMuted}
              strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
            />
            <Text style={sidebarStyles.label} numberOfLines={1}>
              {t("settings.addHost")}
            </Text>
          </Pressable>
          {enableBuiltInDaemonOption.visible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.enableBuiltInDaemon")}
              onPress={enableBuiltInDaemonOption.onPress}
              testID="settings-enable-built-in-daemon"
              style={sidebarItemStyle}
            >
              <Server
                size={theme.iconSize.md}
                color={theme.colors.foregroundMuted}
                strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
              />
              <Text style={sidebarStyles.label} numberOfLines={1}>
                {t("settings.enableBuiltInDaemon")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );

  return (
    <View
      accessibilityLabel={t("settings.title")}
      role="navigation"
      style={outerContainerStyle}
      testID="settings-sidebar"
    >
      {isDesktop ? (
        <View style={innerContainerStyle}>
          <View style={sidebarStyles.sidebarDragArea}>
            <TitlebarDragRegion />
            <WindowChromeSafeArea placement="below" />
            <View style={sidebarStyles.modeHeader} testID="settings-mode-header">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={ArrowLeft}
                onPress={onBackToWorkspace}
                testID="settings-back-to-workspace"
                style={sidebarStyles.backButton}
              >
                {t("settings.backToWorkspace")}
              </Button>
            </View>
          </View>
          <View style={sidebarStyles.search}>
            <SettingsSearchBox search={search} />
          </View>
          <ScrollView
            style={sidebarStyles.scrollBody}
            showsVerticalScrollIndicator={false}
            testID="settings-sidebar-scroll-body"
          >
            {sidebarBody}
          </ScrollView>
          <InstallationRestartBanner placement="sidebar" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${appVersionText}, check for updates`}
            onPress={openUpdates}
            style={sidebarStyles.versionButton}
            testID="settings-sidebar-version"
          >
            <Text style={sidebarStyles.version}>{appVersionText}</Text>
          </Pressable>
        </View>
      ) : (
        sidebarBody
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

/** What pane bodies need from the settings screen. */
interface PaneContext {
  appVersion: string | null;
  appVersionText: string;
  isDesktopApp: boolean;
  settings: AppSettings;
  restartRequestId: string | null;
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  onAddHost: () => void;
  onHostRemoved: () => void;
  onLanguageChange: (language: AppLanguage) => void;
  onPlaybackTest: () => Promise<void>;
  onUseLegacyTerminalRendererChange: (value: boolean) => void;
  onOpenPane: (paneId: string) => void;
}

type InstallationPaneSection = Parameters<typeof InstallationSettingsContent>[0]["section"];

function installationPane(section: InstallationPaneSection) {
  return (context: PaneContext) => (
    <InstallationSettingsContent section={section} onAddHost={context.onAddHost} />
  );
}

/** Each catalog pane's body. Panes reuse the existing settings components. */
const PANE_RENDERERS: Record<string, (context: PaneContext) => ReactNode> = {
  "general.attention": (context) => <AttentionSection onOpenPane={context.onOpenPane} />,
  "general.newWorkspace": () => <WorkspaceDefaultsSection />,
  "general.sending": () => <SendingSection />,
  "general.notifications": () => <DesktopNotificationsSection />,
  "accounts.providers": installationPane("providers"),
  "accounts.profiles": installationPane("profiles"),
  "accounts.usage": installationPane("usage"),
  "agents.tools": installationPane("agents"),
  "agents.skills": () => <SkillLibraryContent />,
  "agents.metadata": installationPane("metadata"),
  "agents.browserData": () => <BrowserDataSection />,
  "agents.permissions": () => <DesktopPermissionsSection />,
  "chat.chat": () => <ChatSection />,
  "chat.openLocation": () => <OpenLocationSection />,
  "chat.editor": () => <EditorSection />,
  "chat.shortcuts": () => <KeyboardShortcutsSection />,
  "terminal.terminal": () => <TerminalSection />,
  "terminal.profiles": installationPane("terminals"),
  "appearance.appearance": () => <AppearanceSection />,
  "appearance.language": (context) => (
    <LanguageSection settings={context.settings} handleLanguageChange={context.onLanguageChange} />
  ),
  "workspaces.projects": installationPane("projects"),
  "workspaces.workspaces": installationPane("workspaces"),
  "environments.environments": (context) => (
    <EnvironmentsPane onHostRemoved={context.onHostRemoved} />
  ),
  "environments.connections": (context) => (
    <>
      <InstallationConnectionCheck />
      {installationPane("connections")(context)}
    </>
  ),
  "plugins.plugins": installationPane("plugins"),
  "plugins.integrations": () => <IntegrationsSection />,
  "maintenance.installation": (context) => (
    <>
      <InstallationControls requestId={context.restartRequestId} />
      <SystemProjectCard />
    </>
  ),
  "maintenance.updates": () => <VortonUpdatesSection />,
  "maintenance.upstream": () => <UpstreamUpdatesSection />,
  "maintenance.diagnostics": (context) => (
    <DiagnosticsSection
      useLegacyTerminalRenderer={context.settings.useLegacyTerminalRenderer}
      onUseLegacyTerminalRendererChange={context.onUseLegacyTerminalRendererChange}
      voiceAudioEngine={context.voiceAudioEngine}
      isPlaybackTestRunning={context.isPlaybackTestRunning}
      playbackTestResult={context.playbackTestResult}
      handlePlaybackTest={context.onPlaybackTest}
    />
  ),
  "about.about": (context) => (
    <AboutSection appVersionText={context.appVersionText} isDesktopApp={context.isDesktopApp} />
  ),
  "about.hosts": (context) => <ConnectedHostsSection clientVersion={context.appVersion} />,
};

// ---------------------------------------------------------------------------
// Drill-in pages
// ---------------------------------------------------------------------------

function resolveDetailTitle(
  view: SettingsView,
  installedPlugins: ReturnType<typeof useInstalledPlugins>,
  t: TFunction,
): string | undefined {
  if (view.kind === "plugin") {
    const screen = installedPlugins
      .find((plugin) => plugin.serverId === view.serverId && plugin.id === view.pluginId)
      ?.settingsScreens.find((candidate) => candidate.id === view.screenId);
    return `${view.pluginId} · ${screen?.title ?? t("settings.title")}`;
  }
  if (view.kind === "host") {
    const item = HOST_SECTION_ITEMS.find((s) => s.id === view.section);
    return item ? t(item.labelKey) : undefined;
  }
  if (view.kind === "project") return t("settings.projects");
  return undefined;
}

function renderDetailContent(
  view: SettingsView,
  options: { isCompactLayout: boolean; onBack: () => void; onHostRemoved: () => void },
): ReactNode {
  if (view.kind === "plugin") {
    return (
      <PluginSettingsContent
        serverId={view.serverId}
        pluginId={view.pluginId}
        screenId={view.screenId}
        onBackToPlugins={options.onBack}
        showBackToPlugins={!options.isCompactLayout}
      />
    );
  }
  if (view.kind === "host") return renderHostSettingsContent(view, options.onHostRemoved);
  if (view.kind === "project") {
    return (
      <ProjectSettingsScreen
        serverId={view.serverId}
        projectId={view.projectId}
        onBackToProjects={options.onBack}
        showBackToProjects={!options.isCompactLayout}
      />
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: SettingsView;
  openAddHostIntent?: string | null;
  installationRequested?: boolean;
  restartRequestId?: string | null;
  /** Catalog entry id to scroll to and highlight, from `?setting=`. */
  settingId?: string | null;
}

export default function SettingsScreen({
  view,
  openAddHostIntent = null,
  installationRequested = false,
  restartRequestId = null,
  settingId = null,
}: SettingsScreenProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const [isAddHostMethodVisible, setIsAddHostMethodVisible] = useState(false);
  const [isDirectHostVisible, setIsDirectHostVisible] = useState(false);
  const [isRemoteSshVisible, setIsRemoteSshVisible] = useState(false);
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);
  const lastOpenedAddHostIntentRef = useRef<string | null>(null);
  const isDesktopApp = isElectronRuntime();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const isCompactLayout = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const insetBottomStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);

  const availability = useAvailabilityContext();
  const sections = useSettingsSections(availability);
  const entries = useSearchEntries(sections, availability);
  const navigation = useSettingsNavigation({
    view,
    installationRequested,
    settingId,
    isCompactLayout,
    hasInstallation: availability.hasInstallation,
    sections,
    entries,
  });
  const { query, search, results, request, activeSection } = navigation;
  useSettingsSearchShortcut();
  const searching = query.trim().length > 0;

  const handleLanguageChange = useCallback(
    (language: AppLanguage) => {
      void updateSettings({ language });
    },
    [updateSettings],
  );

  const handleUseLegacyTerminalRendererChange = useCallback(
    (useLegacyTerminalRenderer: boolean) => {
      void updateSettings({ useLegacyTerminalRenderer });
    },
    [updateSettings],
  );

  const handlePlaybackTest = useCallback(async () => {
    if (!voiceAudioEngine || isPlaybackTestRunning) {
      return;
    }

    setIsPlaybackTestRunning(true);
    setPlaybackTestResult(null);

    try {
      const bytes = Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64");
      await voiceAudioEngine.initialize();
      voiceAudioEngine.stop();
      await voiceAudioEngine.play({
        type: "audio/pcm;rate=16000;bits=16",
        size: bytes.byteLength,
        async arrayBuffer() {
          return Uint8Array.from(bytes).buffer;
        },
      });
      setPlaybackTestResult(null);
    } catch (error) {
      console.error("[Settings] Playback test failed", error);
      setPlaybackTestResult(
        t("settings.diagnostics.playbackFailed", { message: toErrorMessage(error) }),
      );
    } finally {
      setIsPlaybackTestRunning(false);
    }
  }, [isPlaybackTestRunning, t, voiceAudioEngine]);

  const closeAddConnectionFlow = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsDirectHostVisible(false);
    setIsRemoteSshVisible(false);
  }, []);

  const goBackToAddConnectionMethods = useCallback(() => {
    setIsDirectHostVisible(false);
    setIsRemoteSshVisible(false);
    setIsAddHostMethodVisible(true);
  }, []);

  const handleAddHost = useCallback(() => {
    setIsAddHostMethodVisible(true);
  }, []);

  useEffect(() => {
    if (!openAddHostIntent || lastOpenedAddHostIntentRef.current === openAddHostIntent) {
      return;
    }
    lastOpenedAddHostIntentRef.current = openAddHostIntent;
    handleAddHost();
  }, [handleAddHost, openAddHostIntent]);

  const handleSelectDirectConnection = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsDirectHostVisible(true);
  }, []);

  const handleSelectRemoteSsh = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsRemoteSshVisible(true);
  }, []);

  const handleHostAdded = useCallback(
    ({ serverId }: { serverId: string }) => {
      const target = buildSettingsHostSectionRoute(serverId, "connections");
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleHostRemoved = useCallback(() => {
    if (isCompactLayout) {
      router.replace("/settings");
    } else {
      router.replace(buildSettingsSectionRoute("general"));
    }
  }, [isCompactLayout, router]);

  const handleBackFromDetail = useCallback(() => {
    returnFromSettings(view);
  }, [view]);

  const handleBackToWorkspace = useCallback(() => {
    returnFromSettings({ kind: "root" });
  }, []);

  const paneContext = useMemo<PaneContext>(
    () => ({
      appVersion,
      appVersionText,
      isDesktopApp,
      settings,
      restartRequestId,
      voiceAudioEngine,
      isPlaybackTestRunning,
      playbackTestResult,
      onAddHost: handleAddHost,
      onHostRemoved: handleHostRemoved,
      onLanguageChange: handleLanguageChange,
      onPlaybackTest: handlePlaybackTest,
      onUseLegacyTerminalRendererChange: handleUseLegacyTerminalRendererChange,
      onOpenPane: navigation.openPane,
    }),
    [
      appVersion,
      appVersionText,
      handleAddHost,
      handleHostRemoved,
      handleLanguageChange,
      handlePlaybackTest,
      handleUseLegacyTerminalRendererChange,
      isDesktopApp,
      isPlaybackTestRunning,
      navigation.openPane,
      playbackTestResult,
      restartRequestId,
      settings,
      voiceAudioEngine,
    ],
  );
  const renderPane = useCallback(
    (paneId: string): ReactNode => PANE_RENDERERS[paneId]?.(paneContext) ?? null,
    [paneContext],
  );

  const installedPlugins = useInstalledPlugins();
  const detailTitle = resolveDetailTitle(view, installedPlugins, t);
  const detailContent = renderDetailContent(view, {
    isCompactLayout,
    onBack: handleBackFromDetail,
    onHostRemoved: handleHostRemoved,
  });

  if (settingsLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t("settings.loading")}</Text>
      </View>
    );
  }

  const scrollPage = (
    <SettingsScrollPage
      sections={sections}
      renderPane={renderPane}
      request={request}
      onActiveSectionChange={navigation.handleActiveSectionChange}
      query={query}
      results={results}
      matchedPanes={navigation.matchedPanes}
      selectedResult={navigation.selectedResult}
      onSelectResult={navigation.handleSelectResult}
      search={isCompactLayout ? search : undefined}
      bottomInset={insets.bottom}
    />
  );

  const showScrollPage = view.kind === "section" || searching;
  const activeLabel = sections.find((section) => section.id === activeSection)?.label;
  const detailPage = showScrollPage ? (
    <View style={styles.container}>
      {isCompactLayout ? (
        <BackHeader
          title={view.kind === "section" && !searching ? activeLabel : t("settings.title")}
          onBack={view.kind === "section" ? handleBackFromDetail : handleBackToWorkspace}
        />
      ) : (
        <MenuHeader borderless />
      )}
      {scrollPage}
    </View>
  ) : (
    <PageLayout
      title={detailTitle}
      titleTestID="settings-detail-header-title"
      onBack={handleBackFromDetail}
    >
      {detailContent}
    </PageLayout>
  );

  const addHostModals = (
    <>
      <AddHostMethodModal
        visible={isAddHostMethodVisible}
        onClose={closeAddConnectionFlow}
        onDirectConnection={handleSelectDirectConnection}
        onRemoteSsh={handleSelectRemoteSsh}
      />
      <AddHostModal
        visible={isDirectHostVisible}
        onClose={closeAddConnectionFlow}
        onCancel={goBackToAddConnectionMethods}
        onSaved={handleHostAdded}
      />
      <AddRemoteSshHostModal
        visible={isRemoteSshVisible}
        onClose={closeAddConnectionFlow}
        onCancel={goBackToAddConnectionMethods}
        onSaved={handleHostAdded}
      />
    </>
  );

  const selectedSection = selectedSidebarSection(view, searching, activeSection);

  // Mobile root: search above the section list; a query swaps the list for results.
  if (isCompactLayout && view.kind === "root") {
    return (
      <View style={styles.container}>
        {searching ? (
          detailPage
        ) : (
          <>
            <BackHeader title={t("settings.title")} onBack={handleBackToWorkspace} />
            <ScrollView
              style={styles.scrollView}
              contentContainerStyle={insetBottomStyle}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.compactSearch}>
                <SettingsSearchBox search={search} />
              </View>
              <SettingsSidebar
                appVersionText={appVersionText}
                sections={sections}
                selectedSection={null}
                onSelectSection={navigation.handleSelectSection}
                onAddHost={handleAddHost}
                onBackToWorkspace={handleBackToWorkspace}
                search={search}
                layout="mobile"
              />
            </ScrollView>
          </>
        )}
        {addHostModals}
      </View>
    );
  }

  if (isCompactLayout) {
    return (
      <View style={styles.container}>
        {detailPage}
        {addHostModals}
      </View>
    );
  }

  // Desktop split view — mirrors AppContainer: sidebar owns the titlebar drag
  // region + traffic-light padding; detail pane renders whatever header the
  // selected section provides.
  return (
    <View style={styles.container}>
      <View style={desktopStyles.row}>
        <WindowChromeRegion corners="top-left">
          <SettingsSidebar
            appVersionText={appVersionText}
            sections={sections}
            selectedSection={selectedSection}
            onSelectSection={navigation.handleSelectSection}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            search={search}
            layout="desktop"
          />
        </WindowChromeRegion>
        <WindowChromeRegion corners="top-right">
          <View style={desktopStyles.contentPane} testID="settings-detail-pane">
            {detailPage}
          </View>
        </WindowChromeRegion>
      </View>
      {addHostModals}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  aboutVersionMismatch: {
    color: theme.colors.palette.amber[500],
  },
  aboutErrorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  aboutCommunity: {
    marginTop: theme.spacing[4],
  },
  compactSearch: {
    flexDirection: "row",
    paddingTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  aboutUpdateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

const desktopStyles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
  },
});

const sidebarStyles = StyleSheet.create((theme) => ({
  floatingContainer: {
    margin: FLOATING_PANEL_INSET,
    overflow: "hidden",
  },
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
  },
  scrollBody: {
    flex: 1,
  },
  search: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  version: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  versionButton: {
    minHeight: 44,
    justifyContent: "center",
    padding: theme.spacing[3],
  },
  modeHeader: {
    height: VORTON_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-start",
    borderRadius: theme.borderRadius.md,
  },
  sidebarDragArea: {
    position: "relative",
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  list: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[0.5],
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  label: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  pickerTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  // Match the setting items' icon footprint so the host label aligns with them.
  pickerTriggerDot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
