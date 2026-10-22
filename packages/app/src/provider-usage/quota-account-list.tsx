import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";
import { providerConnectionAction } from "./connection-action";
import { formatAmount } from "./format";
import {
  LOW_QUOTA_PCT,
  type QuotaAccount,
  type QuotaBalanceRow,
  type QuotaWindowRow,
} from "./global-quota";
import { ProviderReconnectControl } from "./reconnect-control";
import { ProviderResetControl } from "./reset-control";
import { formatCountdown, formatResetMoment, formatUtcMoment } from "./reset-time";
import type { ProviderUsageView } from "./types";

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const Down = withUnistyles(ChevronDown, iconColor);
const Right = withUnistyles(ChevronRight, iconColor);
const CRITICAL_PCT = 5;

type Tone = "ok" | "warning" | "danger" | "stale";

function toneOf(remaining: number | null, stale: boolean): Tone {
  if (stale) return "stale";
  if (remaining !== null && remaining < CRITICAL_PCT) return "danger";
  if (remaining !== null && remaining < LOW_QUOTA_PCT) return "warning";
  return "ok";
}

/** The card body's accounts, separated so it renders without a live usage host. */
export function QuotaAccountList({
  accounts,
  serverId,
  view,
  now,
}: {
  accounts: readonly QuotaAccount[];
  serverId: string | null;
  view: ProviderUsageView;
  now: number;
}) {
  return accounts.map((account, index) => (
    <AccountSection
      key={account.providerId}
      account={account}
      first={index === 0}
      only={accounts.length === 1}
      serverId={serverId}
      view={view}
      now={now}
    />
  ));
}

function AccountSection({
  account,
  first,
  only,
  serverId,
  view,
  now,
}: {
  account: QuotaAccount;
  first: boolean;
  only: boolean;
  serverId: string | null;
  view: ProviderUsageView;
  now: number;
}) {
  const choice = usePanelStore((state) => state.quotaAccountExpanded[account.providerId]);
  // A lone account has nothing to make room for; otherwise healthy accounts start collapsed.
  const expanded = choice ?? (only || account.attention);
  const toggle = useCallback(() => {
    usePanelStore.getState().setQuotaAccountExpanded(account.providerId, !expanded);
  }, [account.providerId, expanded]);
  const Chevron = expanded ? Down : Right;
  const toggleState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View
      style={[styles.account, taskCardStyles.proseInset, !first && taskCardStyles.separator]}
      testID={`global-quota-account-${account.providerId}`}
    >
      <View style={styles.header}>
        <Pressable
          onPress={toggle}
          style={styles.headerToggle}
          accessibilityRole="button"
          accessibilityState={toggleState}
          accessibilityLabel={`${account.name}${account.status ? `, ${account.status}` : ""}`}
          testID={`global-quota-toggle-${account.providerId}`}
        >
          <Chevron size={12} />
          <Text style={styles.name} numberOfLines={1}>
            {account.name}
          </Text>
          {account.plan ? (
            <Text style={styles.plan} numberOfLines={1}>
              {account.plan}
            </Text>
          ) : null}
        </Pressable>
        {account.running > 0 ? (
          <Text
            style={styles.running}
            accessibilityLabel={`${account.running} ${account.running === 1 ? "agent" : "agents"} running`}
          >
            ● {account.running}
          </Text>
        ) : null}
        <AccountAction account={account} serverId={serverId} view={view} />
      </View>
      {expanded ? (
        <AccountBody account={account} now={now} />
      ) : (
        <CollapsedSummary account={account} />
      )}
    </View>
  );
}

/** The profile selector's account controls: Reconnect when signed out, else reset credits. */
function AccountAction({
  account,
  serverId,
  view,
}: {
  account: QuotaAccount;
  serverId: string | null;
  view: ProviderUsageView;
}) {
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((entry) => entry.providerId === account.providerId)
      : undefined;
  const action = providerConnectionAction({
    providerId: account.providerId,
    providers: config?.providers,
    usage,
    snapshot: entries?.find((entry) => entry.provider === account.providerId),
  });
  if (action) {
    return (
      <ProviderReconnectControl
        usage={usage}
        serverId={serverId}
        providerId={account.providerId}
        name={account.name}
      />
    );
  }
  return (
    <ProviderResetControl
      serverId={serverId}
      providerId={account.providerId}
      name={account.name}
      compact
    />
  );
}

function CollapsedSummary({ account }: { account: QuotaAccount }) {
  const parts = account.windows
    .filter((window) => !window.separate && window.remaining !== null)
    .map((window) => `${window.summaryLabel} ${Math.round(window.remaining!)}%`);
  for (const balance of account.balances) {
    if (balance.limit !== null && balance.remaining !== null)
      parts.push(`${formatAmount(balance.remaining, balance.unit)} left`);
  }
  const next = formatResetMoment(account.nextResetAt);
  if (next) parts.push(`next reset ${next}`);
  const tone = toneOf(account.remaining, false);
  return (
    <Text
      style={[
        styles.summary,
        tone === "warning" && styles.warning,
        tone === "danger" && styles.danger,
      ]}
      testID={`global-quota-summary-${account.providerId}`}
    >
      {account.status ? (
        <Text style={account.failing ? styles.danger : styles.warning}>{account.status} · </Text>
      ) : null}
      {parts.join(" · ")}
    </Text>
  );
}

function AccountBody({ account, now }: { account: QuotaAccount; now: number }) {
  let status = account.status;
  if (account.disconnected && account.windows.length && account.fetchedAt) {
    status = `Account disconnected. Showing last known usage from ${formatResetMoment(account.fetchedAt)}.`;
  }
  return (
    <View style={styles.body}>
      {status ? (
        <Text style={[styles.status, account.failing && styles.danger]}>{status}</Text>
      ) : null}
      {account.windows.map((window) => (
        <WindowRow
          key={window.id}
          window={window}
          account={account}
          stale={account.disconnected}
          now={now}
        />
      ))}
      {account.balances.map((balance) => (
        <BalanceRow key={balance.id} balance={balance} now={now} />
      ))}
      {account.details.map((detail) => (
        <View key={detail.id} style={styles.detail}>
          <Text style={styles.detailLabel} numberOfLines={1}>
            {detail.label}
          </Text>
          <Text
            style={[
              styles.detailValue,
              detail.tone === "warning" && styles.warning,
              detail.tone === "danger" && styles.danger,
            ]}
          >
            {detail.value}
          </Text>
        </View>
      ))}
      {account.source ? <Text style={styles.source}>via {account.source}</Text> : null}
    </View>
  );
}

function Meter({ remaining, tone, label }: { remaining: number; tone: Tone; label: string }) {
  const fill = useMemo(
    () => [
      styles.fill,
      tone === "warning" && styles.warningFill,
      tone === "danger" && styles.dangerFill,
      tone === "stale" && styles.staleFill,
      { width: `${remaining}%` as `${number}%` },
    ],
    [remaining, tone],
  );
  const value = useMemo(() => ({ min: 0, max: 100, now: Math.round(remaining) }), [remaining]);
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={value}
    >
      <View style={fill} />
    </View>
  );
}

function WindowRow({
  window,
  account,
  stale,
  now,
}: {
  window: QuotaWindowRow;
  account: QuotaAccount;
  stale: boolean;
  now: number;
}) {
  const tone = toneOf(window.remaining, stale);
  const passed = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
  return (
    <View testID={`global-quota-window-${account.providerId}-${window.id}`}>
      <View style={styles.windowTop}>
        <Text style={styles.windowLabel} numberOfLines={1}>
          {window.label}
        </Text>
        {window.limiting ? <Text style={styles.limitingTag}>limiting</Text> : null}
        {window.separate ? <Text style={styles.separateTag}>separate</Text> : null}
        <Text
          style={[
            styles.pct,
            tone === "warning" && styles.warning,
            tone === "danger" && styles.danger,
          ]}
        >
          {window.remaining === null ? "Unknown" : `${Math.round(window.remaining)}%`}
          <Text style={styles.pctUnit}>{window.remaining === null ? "" : " left"}</Text>
        </Text>
      </View>
      {window.remaining !== null ? (
        <Meter
          remaining={window.remaining}
          tone={tone}
          label={`${account.name} ${window.label} remaining`}
        />
      ) : null}
      <MomentLine
        prefix={passed ? "Reset" : "Resets"}
        suffix={passed && stale ? " (awaiting refresh)" : ""}
        iso={window.resetsAt}
        now={now}
      />
      {window.runsOutAt && !stale ? (
        <MomentLine
          prefix="At this pace, runs out"
          iso={window.runsOutAt}
          now={now}
          danger
          testID={`global-quota-pace-${account.providerId}-${window.id}`}
        />
      ) : null}
    </View>
  );
}

function BalanceRow({ balance, now }: { balance: QuotaBalanceRow; now: number }) {
  if (balance.remaining === null) return null;
  if (balance.limit === null) {
    return (
      <View style={styles.detail}>
        <Text style={styles.detailLabel} numberOfLines={1}>
          {balance.label}
        </Text>
        <Text style={[styles.detailValue, balance.remaining <= 0 && styles.warning]}>
          {formatAmount(balance.remaining, balance.unit)}
          {unitSuffix(balance)} left
        </Text>
      </View>
    );
  }
  const remainingPct = Math.max(0, Math.min(100, (100 * balance.remaining) / balance.limit));
  const tone = toneOf(remainingPct, false);
  return (
    <View>
      <View style={styles.windowTop}>
        <Text style={styles.windowLabel} numberOfLines={1}>
          {balance.label}
        </Text>
        <Text
          style={[
            styles.pct,
            tone === "warning" && styles.warning,
            tone === "danger" && styles.danger,
          ]}
        >
          {formatAmount(balance.remaining, balance.unit)}
          <Text style={styles.pctUnit}>
            {` of ${formatAmount(balance.limit, balance.unit)}${unitSuffix(balance)} left`}
          </Text>
        </Text>
      </View>
      <Meter remaining={remainingPct} tone={tone} label={`${balance.label} remaining`} />
      <MomentLine prefix="Renews" iso={balance.resetsAt} now={now} />
    </View>
  );
}

function unitSuffix(balance: QuotaBalanceRow): string {
  if (balance.unit === "credits") return " credits";
  if (balance.unit === "requests") return " requests";
  return "";
}

/** An absolute moment with its countdown; hovering or pressing shows the same moment in UTC. */
function MomentLine({
  prefix,
  suffix = "",
  iso,
  now,
  danger = false,
  testID,
}: {
  prefix: string;
  suffix?: string;
  iso: string | null;
  now: number;
  danger?: boolean;
  testID?: string;
}) {
  const moment = formatResetMoment(iso);
  if (!moment) {
    return prefix === "Resets" ? <Text style={styles.moment}>Reset time unavailable</Text> : null;
  }
  const countdown = formatCountdown(iso, now);
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <View style={styles.momentRow} testID={testID}>
          <Text style={[styles.moment, danger && styles.danger]}>
            {`${prefix} ${moment}${suffix}`}
            {countdown ? (
              // Non-breaking spaces keep the countdown on one line when the moment wraps.
              <Text style={styles.countdown}>{` ·\u00a0${countdown.replace(/ /g, "\u00a0")}`}</Text>
            ) : null}
          </Text>
        </View>
      </TooltipTrigger>
      <TooltipContent maxWidth={320}>
        <TooltipText label={moment} description={formatUtcMoment(iso) ?? undefined} />
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  account: { gap: theme.spacing[1], paddingVertical: theme.spacing[2] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minWidth: 0 },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  plan: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: 4,
  },
  running: {
    flexShrink: 0,
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  summary: {
    marginLeft: 16,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  body: { marginLeft: 16, gap: theme.spacing[2] },
  status: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  windowTop: { flexDirection: "row", alignItems: "baseline", gap: theme.spacing[1] },
  windowLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  limitingTag: {
    flexShrink: 0,
    color: theme.colors.accent,
    fontSize: 10,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    borderRadius: 3,
    paddingHorizontal: 3,
  },
  separateTag: { flexShrink: 0, color: theme.colors.foregroundExtraMuted, fontSize: 10 },
  pct: {
    marginLeft: "auto",
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  pctUnit: { color: theme.colors.foregroundExtraMuted, fontWeight: theme.fontWeight.normal },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
    marginVertical: 3,
  },
  fill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.statusDotRunning },
  warningFill: { backgroundColor: theme.colors.statusWarning },
  dangerFill: { backgroundColor: theme.colors.statusDanger },
  staleFill: { backgroundColor: theme.colors.foregroundExtraMuted },
  momentRow: { alignSelf: "flex-start", maxWidth: "100%" },
  moment: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
    fontVariant: ["tabular-nums"],
  },
  countdown: { color: theme.colors.foregroundExtraMuted },
  detail: { flexDirection: "row", gap: theme.spacing[2] },
  detailLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detailValue: { flexShrink: 0, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  source: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm - 1 },
  warning: { color: theme.colors.statusWarning },
  danger: { color: theme.colors.statusDanger },
}));
