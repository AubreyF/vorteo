import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { quotaReading } from "@/provider-usage/quota-reading";
import { formatPct, formatResetLabel } from "@/provider-usage/format";
import { ProviderResetControl } from "@/provider-usage/reset-control";
import type { ProviderUsageView } from "@/provider-usage/types";
import { ProfileLoadingSpinner, profileTileStyles } from "./profile-selector-tile";

interface UsageProps {
  view: ProviderUsageView;
  providerId: string;
  now: number;
}

export function AccountUsageBadge({ view, providerId, now }: UsageProps) {
  const { window, statusLabel } = quotaReading(view, providerId, now);
  const loading = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  const critical = Boolean(window && window.remainingPct < 5);
  const meterValue = useMemo(
    () => ({ min: 0, max: 100, now: window?.remainingPct ?? 0 }),
    [window?.remainingPct],
  );
  return (
    <View style={styles.badge} testID={`preset-usage-${providerId}`}>
      {loading ? (
        <View testID={`preset-usage-loading-${providerId}`}>
          <ProfileLoadingSpinner />
        </View>
      ) : null}
      {window ? (
        <>
          <Text
            style={[styles.remaining, critical && styles.critical]}
            accessibilityLabel={`${formatPct(window.remainingPct)} left${statusLabel ? `, ${statusLabel}` : ""}`}
          >
            {formatPct(window.remainingPct)} left
          </Text>
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityLabel="Usage remaining"
            accessibilityValue={meterValue}
          >
            <View
              style={[
                styles.fill,
                critical && styles.criticalFill,
                { width: `${window.remainingPct}%` },
              ]}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

export function AccountUsageDetails({
  view,
  providerId,
  now,
  serverId,
  name,
  resetLoading,
  localStatus,
}: UsageProps & {
  serverId: string | null;
  name: string;
  resetLoading: boolean;
  localStatus?: string;
}) {
  const { window, statusLabel, authRecovery } = quotaReading(view, providerId, now);
  let reset = formatResetLabel(window?.resetsAt)
    ?.replace(/^resets /, "Resets in ")
    .replace(/(\d+)d$/, (_, days) => `${days} ${days === "1" ? "day" : "days"}`);
  if (reset === "resetting now") reset = "Resetting now";
  const description = localStatus ?? (window ? (reset ?? "Reset time unavailable") : statusLabel);
  return (
    <>
      <Text
        style={profileTileStyles.subtitle}
        numberOfLines={1}
        accessibilityLabel={[description, window && statusLabel].filter(Boolean).join(". ")}
      >
        {description}
      </Text>
      {resetLoading ? <ProfileLoadingSpinner /> : null}
      {!localStatus && !authRecovery ? (
        <View style={styles.reset}>
          <ProviderResetControl
            serverId={serverId}
            providerId={providerId}
            name={name}
            critical={Boolean(window && window.remainingPct < 5)}
            compact
            preloaded
          />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 0 },
  remaining: {
    fontSize: theme.fontSize.sm,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    color: theme.colors.foregroundMuted,
  },
  critical: { color: theme.colors.destructive },
  track: {
    width: 32,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface4,
    overflow: "hidden",
  },
  fill: { height: "100%", backgroundColor: theme.colors.accent },
  criticalFill: { backgroundColor: theme.colors.destructive },
  reset: { justifyContent: "center", height: Math.ceil(theme.fontSize.base * 1.4), flexShrink: 0 },
}));
