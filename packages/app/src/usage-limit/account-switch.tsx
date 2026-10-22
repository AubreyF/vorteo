import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Switch } from "@/components/ui/switch";
import { useReportActionError } from "@/hooks/use-action-error";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";

/** The per-account setting that lets threads continue on their own after a usage limit resets. */
export function UsageLimitResumeSwitch({
  serverId,
  providerId,
  providerLabel,
}: {
  serverId: string;
  providerId: string;
  providerLabel: string;
}) {
  const supported = useHostFeature(serverId, "usageLimitResume");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const reportError = useReportActionError();
  const mutation = useMutation({
    mutationFn: async (autoResumeAfterUsageLimit: boolean) => {
      const result = await patchConfig({
        providers: { [providerId]: { autoResumeAfterUsageLimit } },
      });
      if (!result) throw new Error("Reconnect to the host and try again.");
    },
    onError: reportError,
    retry: false,
  });
  const { mutate } = mutation;
  const toggle = useCallback((value: boolean) => mutate(value), [mutate]);
  if (!supported) return null;
  const saved = config?.providers[providerId]?.autoResumeAfterUsageLimit !== false;
  const value = mutation.isPending ? mutation.variables : saved;
  return (
    <View style={styles.row} testID={`provider-auto-resume-${providerId}`}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Resume after usage limits</Text>
        <Text style={settingsStyles.rowHint}>
          {"Continue stopped threads after this account's limit resets."}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={toggle}
        disabled={mutation.isPending}
        accessibilityLabel={`Resume ${providerLabel} threads after usage limits`}
        testID={`provider-auto-resume-switch-${providerId}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
}));
