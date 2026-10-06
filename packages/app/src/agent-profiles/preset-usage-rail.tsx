import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatProviderUsageSummary } from "@/provider-usage/compact-summary";
import { clampPct, formatPct, formatResetLabel } from "@/provider-usage/format";
import { quotaReading } from "@/provider-usage/quota-reading";
import type { ProviderUsageView } from "@/provider-usage/types";
import { ProviderResetControl } from "@/provider-usage/reset-control";
import { providerConnectionAction } from "@/provider-usage/connection-action";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useVortonMode } from "@/vorton-mode";

function resetLabel(resetsAt: string | null | undefined): string {
  return (
    formatResetLabel(resetsAt)
      ?.replace(/^resets /, "resets in ")
      .replace(/(\d+)d$/, (_, days) => `${days} ${days === "1" ? "day" : "days"}`) ??
    "Reset time unavailable"
  );
}

export function PresetUsageRail({
  view,
  now,
  localStatus,
  serverId,
  providerId,
  name,
  showConnectionActions = true,
  showResetControl,
}: {
  view: ProviderUsageView;
  now: number;
  localStatus?: string;
  serverId: string | null;
  providerId: string;
  name: string;
  showConnectionActions?: boolean;
  showResetControl?: boolean;
}) {
  const { window, usage, statusLabel } = quotaReading(view, providerId, now);
  const { config } = useDaemonConfig(serverId);
  const vortonMode = useVortonMode();
  const connectionAction = providerConnectionAction({
    vortonMode,
    providerId,
    providers: config?.providers,
    usage,
  });
  const critical = Boolean(window && window.remainingPct < 5);
  const showStatusBelow = vortonMode && Boolean(window && statusLabel);
  const remaining = window?.remainingPct ?? 0;
  const fill = useMemo(
    () => [
      styles.fill,
      critical && styles.criticalFill,
      { width: `${clampPct(remaining)}%` as `${number}%` },
    ],
    [remaining, critical],
  );
  const meterValue = useMemo(() => ({ min: 0, max: 100, now: clampPct(remaining) }), [remaining]);
  if (localStatus) {
    return (
      <View style={styles.rail}>
        <Text style={styles.meta} numberOfLines={1}>
          {localStatus}
        </Text>
      </View>
    );
  }
  const content = (
    <>
      {window ? (
        <>
          <Text style={[styles.remaining, critical && styles.critical]} numberOfLines={1}>
            {formatPct(window.remainingPct)} left
          </Text>
          <View
            style={[styles.track, critical && styles.criticalTrack]}
            accessibilityRole="progressbar"
            accessibilityLabel="Usage remaining"
            accessibilityValue={meterValue}
          >
            <View style={fill} />
          </View>
          {!showStatusBelow ? (
            <Text style={[styles.meta, critical && styles.critical]} numberOfLines={1}>
              {statusLabel ?? resetLabel(window.resetsAt)}
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.meta} numberOfLines={1}>
          {formatProviderUsageSummary(usage) ?? statusLabel}
        </Text>
      )}
      <UsageControlSlot visible={showResetControl} vortonMode={vortonMode}>
        <UsageControls
          connectionAction={connectionAction}
          showConnectionActions={showConnectionActions}
          usage={usage}
          serverId={serverId}
          providerId={providerId}
          name={name}
          critical={critical}
        />
      </UsageControlSlot>
    </>
  );
  const rail = <View style={[styles.rail, vortonMode && styles.railVorton]}>{content}</View>;
  if (!showStatusBelow) return rail;
  return (
    <View style={styles.statusStack}>
      {rail}
      <Text style={[styles.status, critical && styles.critical]}>{statusLabel}</Text>
    </View>
  );
}
function UsageControlSlot({
  visible,
  vortonMode,
  children,
}: {
  visible?: boolean;
  vortonMode: boolean;
  children: ReactNode;
}) {
  if (visible === false) return null;
  return <View style={[styles.resets, vortonMode && styles.resetsVorton]}>{children}</View>;
}
function UsageControls({
  connectionAction,
  showConnectionActions,
  usage,
  serverId,
  providerId,
  name,
  critical,
}: {
  connectionAction: ReturnType<typeof providerConnectionAction>;
  showConnectionActions: boolean;
  usage: Parameters<typeof providerConnectionAction>[0]["usage"];
  serverId: string | null;
  providerId: string;
  name: string;
  critical: boolean;
}) {
  if (connectionAction) {
    if (!showConnectionActions) return null;
    return (
      <ProviderReconnectControl
        usage={usage}
        serverId={serverId}
        providerId={providerId}
        name={name}
      />
    );
  }
  return (
    <ProviderResetControl
      serverId={serverId}
      providerId={providerId}
      name={name}
      critical={critical}
      compact
      preloaded
    />
  );
}
const styles = StyleSheet.create((theme) => ({
  rail: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    minWidth: 0,
    gap: theme.spacing[2],
    height: Math.ceil(theme.fontSize.base * 1.4),
  },
  railVorton: {
    height: "auto",
    minHeight: Math.ceil(theme.fontSize.base * 1.4),
  },
  // Cached-usage warnings need the full row width, including when a reset badge is visible.
  statusStack: { minWidth: 0, gap: theme.spacing[1] },
  status: {
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    color: theme.colors.foregroundMuted,
  },
  remaining: {
    flexShrink: 0,
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    color: theme.colors.foreground,
  },
  critical: { color: theme.colors.destructive },
  criticalTrack: { backgroundColor: theme.colors.destructive, opacity: 0.45 },
  criticalFill: { backgroundColor: theme.colors.destructive },
  resets: {
    width: 88,
    height: Math.ceil(theme.fontSize.base * 1.4),
    flexShrink: 0,
    marginLeft: "auto",
    alignItems: "flex-end",
  },
  resetsVorton: { width: "auto", height: "auto", justifyContent: "center" },
  meta: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    color: theme.colors.foregroundMuted,
  },
  track: {
    width: 40,
    flexShrink: 1,
    height: 4,
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  fill: { height: "100%", backgroundColor: theme.colors.accent },
}));
