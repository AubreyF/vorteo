import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  useAgentProfilePicker,
  type AgentProfileApplyTarget,
} from "@/agent-profiles/internal/use-agent-profile-picker";
import { PresetControls } from "@/agent-profiles/preset-controls";

interface LoadRecoveryProps {
  serverId: string;
  agentId: string;
  onRecovered: () => void;
}

export function AgentLoadRecovery({ serverId, agentId, onRecovered }: LoadRecoveryProps) {
  const { t } = useTranslation();
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const availableProviders = useMemo(
    () =>
      (entries ?? [])
        .filter((entry) => entry.enabled && entry.status === "ready")
        .map((entry) => entry.provider),
    [entries],
  );
  const target = useMemo<AgentProfileApplyTarget>(
    () => ({ kind: "agent", agentId, availableModeIds: null }),
    [agentId],
  );
  const recovery = useMemo(() => ({ onRecovered }), [onRecovered]);
  const picker = useAgentProfilePicker({ serverId, availableProviders, target, recovery });
  return (
    <View style={styles.container} testID="agent-provider-recovery">
      <Text style={styles.message}>{t("agentPanel.states.providerRecovery")}</Text>
      {picker ? (
        <PresetControls serverId={serverId} profiles={picker} disabled={false} />
      ) : (
        <Text style={styles.message}>{t("agentPanel.states.loadingProviders")}</Text>
      )}
      {picker?.handoffElement}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "center",
    gap: theme.spacing[3],
    maxWidth: 480,
    marginTop: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
