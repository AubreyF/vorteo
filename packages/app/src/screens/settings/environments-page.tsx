import { useMemo, useState } from "react";
import { Text } from "react-native";
import { PageLayout } from "@/components/page-layout";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHosts } from "@/runtime/host-runtime";
import { InstallationSettingsStatus } from "@/execution-installation/settings-status";
import { EnvironmentResourceExclusions } from "@/execution-installation/resource-exclusions";
import { settingsStyles } from "@/styles/settings";
import { HostSettingsPage } from "./host-page";

export function EnvironmentsSettingsPage({
  onBack,
  onHostRemoved,
}: {
  onBack: () => void;
  onHostRemoved: () => void;
}) {
  const hosts = useHosts();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = hosts.find((host) => host.serverId === selectedId) ?? hosts[0];
  const options = useMemo(
    () =>
      hosts.map((host) => ({
        value: host.serverId,
        label: host.label,
        testID: `settings-environment-tab-${host.serverId}`,
      })),
    [hosts],
  );
  const selectedServerId = selected?.serverId;
  const tabs = useMemo(
    () =>
      selectedServerId ? (
        <SettingsTabs
          options={options}
          value={selectedServerId}
          onValueChange={setSelectedId}
          testID="settings-environment-tabs"
        />
      ) : null,
    [options, selectedServerId],
  );
  return (
    <PageLayout
      title="Environments"
      titleTestID="settings-detail-header-title"
      testID="settings-environment-scroll"
      onBack={onBack}
      fixedHeader={tabs}
    >
      {selected ? (
        <SettingsSection
          key={selected.serverId}
          title={selected.label}
          testID={`settings-environment-${selected.serverId}`}
        >
          <HostSettingsPage serverId={selected.serverId} onHostRemoved={onHostRemoved} />
          <InstallationSettingsStatus>
            <EnvironmentResourceExclusions serverId={selected.serverId} />
          </InstallationSettingsStatus>
        </SettingsSection>
      ) : (
        <Text style={settingsStyles.rowHint}>Connect an environment to manage settings.</Text>
      )}
    </PageLayout>
  );
}
