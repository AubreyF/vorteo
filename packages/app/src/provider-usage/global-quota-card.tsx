import { Gauge } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { GlobalCard } from "@/components/sidebar/global-card-shell";
import type { Theme } from "@/styles/theme";
import { useUsageHostId } from "@/usage/hosts";
import { useOpenUsageScreen } from "@/usage/sidebar-item";
import { clampPct } from "./format";
import { constrainedCount, LOW_QUOTA_PCT, quotaRows, type QuotaRow } from "./global-quota";
import { useProviderUsage } from "./use-provider-usage";

const QuotaIcon = withUnistyles(Gauge);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const HEADING_ICON = (
  <View style={{ width: 16, alignItems: "center" }}>
    <QuotaIcon size={14} uniProps={iconColor} />
  </View>
);

/** Every account's quota on the usage host, the accounts needing attention first. */
export function GlobalQuotaCard() {
  const serverId = useUsageHostId();
  const { view } = useProviderUsage(serverId, { pollUsage: true });
  // The rows only need minute precision; Date.now() per render is enough.
  const rows = useMemo(() => quotaRows(view, Date.now()), [view]);
  const openUsage = useOpenUsageScreen();
  if (rows.length === 0) return null;
  const attention = constrainedCount(rows);
  const countLabel =
    attention > 0
      ? `${attention} of ${rows.length} accounts need attention`
      : `${rows.length} accounts`;
  return (
    <GlobalCard
      kind="globalQuota"
      title="Quota"
      icon={HEADING_ICON}
      count={rows.length}
      countLabel={countLabel}
      testID="global-quota-card"
    >
      {rows.map((row, index) => (
        <QuotaRowView key={row.providerId} row={row} first={index === 0} onPress={openUsage} />
      ))}
    </GlobalCard>
  );
}

function QuotaRowView({
  row,
  first,
  onPress,
}: {
  row: QuotaRow;
  first: boolean;
  onPress: () => void;
}) {
  const low = row.failing || (row.remaining !== null && row.remaining < LOW_QUOTA_PCT);
  const fill = useMemo(
    () => [
      styles.fill,
      low && styles.lowFill,
      { width: `${clampPct(row.remaining ?? 0)}%` as `${number}%` },
    ],
    [low, row.remaining],
  );
  const label = [row.name, row.summary, row.status].filter(Boolean).join(", ");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens Usage"
      style={[styles.row, taskCardStyles.proseInset, !first && taskCardStyles.separator]}
      testID={`global-quota-row-${row.providerId}`}
    >
      <View style={styles.line}>
        <Text style={styles.name} numberOfLines={1}>
          {row.name}
        </Text>
        {row.summary ? (
          <Text style={[styles.summary, low && styles.low]} numberOfLines={1}>
            {row.summary}
          </Text>
        ) : null}
      </View>
      {row.remaining !== null ? (
        <View style={styles.track}>
          <View style={fill} />
        </View>
      ) : null}
      {row.status ? (
        <Text style={[styles.status, row.failing && styles.low]} numberOfLines={2}>
          {row.status}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { gap: theme.spacing[1], paddingVertical: theme.spacing[2] },
  line: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  name: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  summary: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  low: { color: theme.colors.statusWarning },
  status: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  track: {
    height: 3,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  fill: { height: 3, borderRadius: 2, backgroundColor: theme.colors.statusDotRunning },
  lowFill: { backgroundColor: theme.colors.statusWarning },
}));
