import { Box, Monitor, KeyRound } from "lucide-react-native";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { findInstallationEnvironment, readExecutionInstallation } from "./policy";

const ThemedBox = withUnistyles(Box);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedKey = withUnistyles(KeyRound);
const neutral = (theme: Theme) => ({ color: theme.colors.foreground });

export function ExecutionEnvironmentIcon({
  serverId,
  hostOnly = false,
}: {
  serverId: string | null;
  hostOnly?: boolean;
}) {
  const environment = serverId
    ? findInstallationEnvironment(readExecutionInstallation(), serverId)
    : null;
  if (!environment || (hostOnly && environment.kind !== "host")) return null;
  const size = ICON_SIZE.sm;
  if (environment.kind === "container")
    return (
      <View
        style={styles.monitor}
        testID="execution-environment-container-icon"
        accessibilityLabel="Runs in dev container"
      >
        <ThemedBox size={size} uniProps={neutral} />
      </View>
    );
  return (
    <View
      style={styles.monitor}
      testID="execution-environment-host-icon"
      accessibilityLabel="Runs on host"
    >
      <ThemedMonitor size={size} uniProps={neutral} />
      <View style={styles.key}>
        <ThemedKey size={size / 2} uniProps={neutral} />
      </View>
    </View>
  );
}

export function useHasExecutionEnvironment(serverId: string | null) {
  return Boolean(serverId && findInstallationEnvironment(readExecutionInstallation(), serverId));
}

const styles = StyleSheet.create((theme) => ({
  monitor: {
    width: theme.iconSize.sm + theme.spacing[1],
    height: theme.iconSize.sm,
    flexShrink: 0,
  },
  key: {
    position: "absolute",
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
  },
}));
