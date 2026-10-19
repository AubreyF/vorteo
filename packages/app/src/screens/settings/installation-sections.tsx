import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useState } from "react";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { SharedProvidersPage } from "./shared-providers-page";
import { Text, View } from "react-native";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { SettingsSectionSlug } from "@/utils/host-routes";
import { useHosts } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { useInstallationProfiles } from "@/execution-installation/profiles";
import { selectProfileCatalogSources } from "@/execution-installation/profile-catalog";
import { InstallationSettingsStatus } from "@/execution-installation/settings-status";
import { SharedProviderSection } from "@/agent-profiles/settings/shared-provider-section";
import { AgentProfilesSection } from "@/agent-profiles/settings/agent-profiles-section";
import { Alert } from "@/components/ui/alert";
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

function ProfilesSettings({ serverId }: { serverId: string }) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const profiles = useInstallationProfiles();
  const containerId =
    profiles.installation?.environments.find((environment) => environment.kind === "container")
      ?.serverId ?? null;
  const hostCatalog = useProvidersSnapshot(serverId);
  const containerCatalog = useProvidersSnapshot(containerId);
  const { config: hostConfig } = useDaemonConfig(serverId);
  const { config: containerConfig } = useDaemonConfig(containerId);
  if (!profiles.installation) return <AgentProfilesSection serverId={serverId} />;
  if (profiles.error) return <Alert variant="error" description={profiles.error.message} />;
  if (profiles.isPending) return <Text style={settingsStyles.rowHint}>Loading profiles...</Text>;
  if (!profiles.data) return null;
  const sections = selectProfileCatalogSources([
    { serverId, entries: hostCatalog.entries, providers: hostConfig?.providers },
    {
      serverId: containerId,
      entries: containerCatalog.entries,
      providers: containerConfig?.providers,
    },
  ]);
  for (const type of Object.keys(profiles.data.providers)) {
    if (!sections.has(type)) sections.set(type, { serverId, provider: type });
  }
  if (!sections.size)
    return (
      <Alert description="Connect a provider in Providers settings to create your first profile." />
    );
  const activeType =
    selectedType && sections.has(selectedType) ? selectedType : [...sections.keys()][0];
  const target = sections.get(activeType)!;
  const options = [...sections.keys()].map((type) => ({
    value: type,
    label:
      [...(hostCatalog.entries ?? []), ...(containerCatalog.entries ?? [])].find(
        (entry) => entry.provider === type,
      )?.label ?? type,
  }));
  return (
    <View>
      <Text style={settingsStyles.rowHint}>
        Choose a provider to manage its defaults and profiles. Connections supply accounts; profiles
        define how new tasks run.
      </Text>
      <SettingsTabs
        options={options}
        value={activeType}
        onValueChange={setSelectedType}
        testID="profile-provider-tabs"
      />
      <SharedProviderSection
        key={activeType}
        serverId={target.serverId}
        provider={target.provider}
      />
    </View>
  );
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

  if (section === "providers" && installation) {
    return (
      <InstallationSettingsStatus>
        <SharedProvidersPage />
      </InstallationSettingsStatus>
    );
  }

  if (section === "plugins" && installation) {
    return (
      <InstallationSettingsStatus>
        <SharedPluginsPage />
      </InstallationSettingsStatus>
    );
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
      return <ProfilesSettings serverId={serverId} />;
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
