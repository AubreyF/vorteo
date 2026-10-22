import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SharedProvidersPage } from "./shared-providers-page";
import { Text, View } from "react-native";
import type { SettingsSectionSlug } from "@/utils/host-routes";
import { useHosts } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { InstallationSettingsStatus } from "@/execution-installation/settings-status";
import { AgentProfilesSection } from "@/agent-profiles/settings/agent-profiles-section";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import ProjectsScreen from "@/screens/projects-screen";
import {
  HostAgentsPage,
  HostConnectionsPage,
  HostPairDevicePage,
  HostProvidersPage,
  HostTerminalsPage,
  HostUsagePage,
  HostWorkspacesPage,
} from "./host-page";
import { HostPluginsPage } from "./plugins-page";
import { SharedPluginsPage } from "./shared-plugins-page";
import { MetadataGenerationPage } from "./metadata-generation-page";

export const INSTALLATION_SETTINGS_SECTIONS = [
  "projects",
  "connections",
  "pair-device",
  "agents",
  "metadata",
  "workspaces",
  "providers",
  "profiles",
  "usage",
  "terminals",
  "plugins",
  "environments",
] as const;
type InstallationSettingsSection = (typeof INSTALLATION_SETTINGS_SECTIONS)[number];

export function isInstallationSettingsSection(
  section: SettingsSectionSlug,
): section is InstallationSettingsSection {
  return INSTALLATION_SETTINGS_SECTIONS.some((candidate) => candidate === section);
}

/**
 * Panes that an installation replaces with one shared page. `undefined` means
 * the pane keeps its per-environment content.
 */
function installationWidePane(section: InstallationSettingsSection) {
  switch (section) {
    case "providers":
      return (
        <InstallationSettingsStatus>
          <SharedProvidersPage />
        </InstallationSettingsStatus>
      );
    case "plugins":
      return (
        <InstallationSettingsStatus>
          <SharedPluginsPage />
        </InstallationSettingsStatus>
      );
    // Profiles and usage live on each provider's page.
    case "profiles":
    case "usage":
      return null;
    default:
      return undefined;
  }
}

export function InstallationSettingsContent({
  section,
  onAddHost,
}: {
  section: InstallationSettingsSection;
  onAddHost: () => void;
}) {
  const hosts = useHosts();
  const installation = readExecutionInstallation();
  const authority = installation?.environments.find((environment) => environment.kind === "host");
  const serverId = authority?.serverId ?? hosts[0]?.serverId;
  if (!serverId)
    return (
      <View>
        <Text style={settingsStyles.rowHint}>Connect an environment to manage settings.</Text>
        {section === "connections" ? (
          <Button onPress={onAddHost} testID="settings-add-host">
            Add connection
          </Button>
        ) : null}
      </View>
    );

  if (installation) {
    const shared = installationWidePane(section);
    if (shared !== undefined) return shared;
  }

  switch (section) {
    case "projects":
      return <ProjectsScreen />;
    case "agents":
      return (
        <InstallationSettingsStatus>
          <HostAgentsPage serverId={serverId} />
        </InstallationSettingsStatus>
      );
    case "metadata":
      return (
        <InstallationSettingsStatus>
          <MetadataGenerationPage serverId={serverId} />
        </InstallationSettingsStatus>
      );
    case "workspaces":
      return (
        <InstallationSettingsStatus>
          <HostWorkspacesPage serverId={serverId} />
        </InstallationSettingsStatus>
      );
    case "terminals":
      return (
        <InstallationSettingsStatus>
          <HostTerminalsPage serverId={serverId} />
        </InstallationSettingsStatus>
      );
    case "profiles":
      return <AgentProfilesSection serverId={serverId} />;
  }

  return (
    <View>
      {section === "connections" ? (
        <Button onPress={onAddHost} testID="settings-add-host">
          Add connection
        </Button>
      ) : null}
      {hosts.map((host) => (
        <SettingsSection
          key={host.serverId}
          title={host.label}
          testID={`settings-environment-${host.serverId}`}
        >
          {section === "connections" ? <HostConnectionsPage serverId={host.serverId} /> : null}
          {section === "pair-device" ? <HostPairDevicePage serverId={host.serverId} /> : null}
          {section === "providers" ? <HostProvidersPage serverId={host.serverId} /> : null}
          {section === "usage" ? <HostUsagePage serverId={host.serverId} /> : null}
          {section === "plugins" ? <HostPluginsPage serverId={host.serverId} /> : null}
        </SettingsSection>
      ))}
    </View>
  );
}
