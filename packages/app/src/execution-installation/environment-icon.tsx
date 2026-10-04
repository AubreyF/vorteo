import { Box, Monitor, KeyRound } from "lucide-react-native";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useVortonMode } from "@/vorton-mode";
import { EXECUTION_ENVIRONMENT_COLORS, ICON_SIZE } from "@/styles/theme";
import { findInstallationEnvironment, readExecutionInstallation } from "./policy";

export function ExecutionEnvironmentIcon({
  serverId,
  hostOnly = false,
}: {
  serverId: string | null;
  hostOnly?: boolean;
}) {
  const enabled = useVortonMode();
  const environment =
    enabled && serverId ? findInstallationEnvironment(readExecutionInstallation(), serverId) : null;
  if (!environment || (hostOnly && environment.kind !== "host")) return null;
  const size = ICON_SIZE.sm;
  const color = EXECUTION_ENVIRONMENT_COLORS[environment.kind];
  if (environment.kind === "container") return <Box size={size} color={color} />;
  return (
    <View
      style={styles.monitor}
      testID="execution-environment-host-icon"
      accessibilityLabel="Runs on host"
    >
      <Monitor size={size} color={color} />
      <View style={styles.key}>
        <KeyRound size={size / 2} color={color} />
      </View>
    </View>
  );
}

export function useHasExecutionEnvironment(serverId: string | null) {
  const enabled = useVortonMode();
  return Boolean(
    enabled && serverId && findInstallationEnvironment(readExecutionInstallation(), serverId),
  );
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
