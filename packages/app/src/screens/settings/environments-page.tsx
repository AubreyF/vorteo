import { useMemo, useState } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHosts } from "@/runtime/host-runtime";
import { InstallationSettingsStatus } from "@/execution-installation/settings-status";
import { EnvironmentResourceExclusions } from "@/execution-installation/resource-exclusions";
import { settingsStyles } from "@/styles/settings";
import { HostSettingsPage } from "./host-page";

/**
 * One environment at a time, chosen with tabs that sit inside the pane, under
 * the Environments heading, so the page title stays first. On web the tabs
 * stick to the top of the settings scroll while the environment's details
 * scroll beneath them, and release when the pane ends.
 */
export function EnvironmentsPane({ onHostRemoved }: { onHostRemoved: () => void }) {
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
  if (!selected) {
    return <Text style={settingsStyles.rowHint}>Connect an environment to manage settings.</Text>;
  }
  return (
    <View testID="settings-environment-scroll">
      {hosts.length > 1 ? (
        <View style={[styles.tabs, stickyPosition]}>
          <SettingsTabs
            options={options}
            value={selected.serverId}
            onValueChange={setSelectedId}
            testID="settings-environment-tabs"
          />
        </View>
      ) : null}
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
    </View>
  );
}

// React Native's style types omit `sticky`; React Native Web passes it to CSS.
const stickyPosition = (isWeb ? { position: "sticky", top: 0 } : {}) as unknown as ViewStyle;

const styles = StyleSheet.create((theme) => ({
  tabs: {
    zIndex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
