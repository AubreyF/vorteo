import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { InstallationConnectionCheck } from "@/execution-installation/connection-check-wrapper";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";

import { formatDuration } from "@/utils/time";

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

function reloadStartup(): void {
  if (isWeb) window.location.reload();
}

export function StartupStatus({ phase }: StartupStatusProps) {
  const [delayed, setDelayed] = useState(false);
  const [startedAt] = useState(Date.now);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    setDelayed(false);

    const timer = setTimeout(() => setDelayed(true), 3_000);
    const clock = setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => {
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [startedAt]);

  return (
    <View style={styles.content} testID="startup-status">
      {phase !== "unavailable" ? <Spinner /> : null}
      <Text style={styles.label} accessibilityRole="text" accessibilityLiveRegion="polite">
        {labels[phase]}
      </Text>
      {delayed ? (
        <ScrollView
          style={styles.help}
          contentContainerStyle={styles.details}
          testID="startup-diagnostics"
        >
          <Text style={styles.hint}>
            Taking longer than expected · {formatDuration(elapsedSeconds * 1000)} elapsed.
          </Text>
          <Text style={styles.hint}>
            Interface assets: running. The page may have loaded from cache.
          </Text>
          <Text style={styles.hint}>
            Use the connection check when available. A successful health check does not prove
            session readiness. Check your connection and VPN, and the host address in Settings.
          </Text>
          <InstallationConnectionCheck />
          {isWeb ? (
            <Button variant="outline" onPress={reloadStartup}>
              Reload
            </Button>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    alignItems: "center",
    gap: theme.spacing[3],
    maxWidth: 640,
    width: "100%",
    flexShrink: 1,
  },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  help: { alignSelf: "stretch", maxHeight: 480, flexShrink: 1 },
  details: { gap: theme.spacing[2], padding: theme.spacing[3] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, textAlign: "center" },
}));
