import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
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
  const tabs = useMemo(
    () =>
      hosts.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.tabs} accessibilityRole="tablist" testID="settings-environment-tabs">
            {hosts.map((host) => (
              <EnvironmentTab
                key={host.serverId}
                serverId={host.serverId}
                label={host.label}
                selected={host.serverId === selected?.serverId}
                onSelect={setSelectedId}
              />
            ))}
          </View>
        </ScrollView>
      ) : null,
    [hosts, selected?.serverId],
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

function EnvironmentTab({
  serverId,
  label,
  selected,
  onSelect,
}: {
  serverId: string;
  label: string;
  selected: boolean;
  onSelect: (serverId: string) => void;
}) {
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const select = useCallback(() => onSelect(serverId), [onSelect, serverId]);
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      onPress={select}
      accessibilityRole="tab"
      aria-selected={selected}
      accessibilityState={accessibilityState}
      testID={`settings-environment-tab-${serverId}`}
      style={styles.tab}
    >
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabs: { flexDirection: "row", gap: theme.spacing[2] },
  tab: { minHeight: 44, flexShrink: 0 },
}));
