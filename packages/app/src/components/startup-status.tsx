import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

const Spinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

interface StartupStatusProps {
  phase: "host" | "workspace" | "unavailable";
  children?: React.ReactNode;
}

const labels = {
  unavailable: "Host unavailable",
  host: "Connecting host",
  workspace: "Loading workspace",
};

export function StartupStatus({ phase }: StartupStatusProps) {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    setDelayed(false);

    const timer = setTimeout(() => setDelayed(true), 10_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.content} testID="startup-status">
      {phase !== "unavailable" ? <Spinner /> : null}
      <Text style={styles.label} accessibilityRole="text" accessibilityLiveRegion="polite">
        {labels[phase]}
      </Text>
      {delayed ? (
        <View style={styles.help} testID="startup-diagnostics" accessibilityLiveRegion="polite">
          <Text style={styles.hint}>Taking longer than expected.</Text>
          <Text style={styles.hint}>Check your internet connection and VPN, if required.</Text>
          <Text style={styles.hint}>Make sure the host is awake and Vorteo is running.</Text>
          <Text style={styles.hint}>If this persists, check the host address in Settings.</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { alignItems: "center", gap: theme.spacing[3], maxWidth: 360 },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  help: { gap: theme.spacing[2], paddingTop: theme.spacing[3] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, textAlign: "center" },
}));
