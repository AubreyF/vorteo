import { Gauge } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { GlobalCard } from "@/components/sidebar/global-card-shell";
import type { Theme } from "@/styles/theme";
import { useUsageHostId } from "@/usage/hosts";
import { useOpenUsageScreen } from "@/usage/sidebar-item";
import { attentionCount, quotaAccounts } from "./global-quota";
import { QuotaAccountList } from "./quota-account-list";
import { useProviderUsage } from "./use-provider-usage";

const QuotaIcon = withUnistyles(Gauge);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const HEADING_ICON = (
  <View style={{ width: 16, alignItems: "center" }}>
    <QuotaIcon size={14} uniProps={iconColor} />
  </View>
);

/** Every account's quotas on the usage host, one bar per enforced window or capped balance. */
export function GlobalQuotaCard() {
  const serverId = useUsageHostId();
  const { view } = useProviderUsage(serverId, { pollUsage: true });
  // Readings refresh every minute, so minute-precision countdowns only need the render time.
  const now = useMemo(() => (view.kind === "ready" ? Date.now() : 0), [view]);
  const accounts = useMemo(() => quotaAccounts(view, now), [view, now]);
  const openUsage = useOpenUsageScreen();
  if (accounts.length === 0) return null;
  const attention = attentionCount(accounts);
  const countLabel =
    attention > 0
      ? `${attention} of ${accounts.length} accounts need attention`
      : `${accounts.length} accounts`;
  return (
    <GlobalCard
      kind="globalQuota"
      title={accounts.length === 1 ? "Quota" : "Quotas"}
      icon={HEADING_ICON}
      count={accounts.length}
      countLabel={countLabel}
      testID="global-quota-card"
    >
      <QuotaAccountList accounts={accounts} serverId={serverId} view={view} now={now} />
      <View style={[styles.footer, taskCardStyles.proseInset, taskCardStyles.separator]}>
        <Text style={styles.footerText} numberOfLines={1}>
          Times in {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </Text>
        <Pressable
          onPress={openUsage}
          accessibilityRole="link"
          testID="global-quota-open-usage"
          hitSlop={6}
        >
          <Text style={styles.link}>Open Usage</Text>
        </Pressable>
      </View>
    </GlobalCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  footerText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm - 1,
  },
  link: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
}));
