import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { AgentContextGroup } from "@getpaseo/protocol/agent-context";
import type { Theme } from "@/styles/theme";
import {
  buildBreakdownModel,
  buildTotalsModel,
  formatBreakdownTokens,
  formatPercent,
  layoutDonut,
  seriesColor,
  type ContextBreakdownModel,
  type ContextRow,
} from "./model";
import { useContextBreakdown } from "./use-context-breakdown";

const DONUT_SIZE = 88;
const DONUT_STROKE = 12;
const DONUT_RADIUS = (DONUT_SIZE - DONUT_STROKE) / 2;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
const DONUT_CENTER = DONUT_SIZE / 2;
/** The 2px surface gap between adjacent fills. */
const DONUT_GAP = 2;

/**
 * The context window's composition: a donut beside the headline numbers, then a legend with each
 * category's tokens and share of the window. Providers that report totals only get used and free.
 */
export function ContextBreakdown({
  serverId,
  agentId,
  percentage,
  usedTokens,
  maxTokens,
  sessionCost,
  interactive,
}: {
  serverId: string;
  agentId: string;
  percentage: number;
  usedTokens: number;
  maxTokens: number;
  sessionCost: string | null;
  /** Whether item groups can be expanded; a hover popover cannot be pressed. */
  interactive: boolean;
}) {
  const { t } = useTranslation();
  const view = useContextBreakdown(serverId, agentId);
  const model = useMemo<ContextBreakdownModel>(
    () =>
      view.kind === "ready"
        ? buildBreakdownModel(view.breakdown)
        : buildTotalsModel({
            usedTokens,
            maxTokens,
            usedLabel: t("contextWindow.breakdown.used"),
            freeLabel: t("contextWindow.breakdown.free"),
          }),
    [maxTokens, t, usedTokens, view],
  );
  const note = breakdownNote(view.kind, t);
  const overLimit = view.kind === "ready" ? view.breakdown.overLimit : undefined;

  return (
    <View style={styles.root} testID="context-breakdown">
      <View style={styles.summaryRow}>
        <Donut model={model} percentage={percentage} />
        <View style={styles.summaryText}>
          <Text style={styles.headline}>{t("contextWindow.used", { percentage })}</Text>
          <Text style={styles.detail}>
            {t("contextWindow.tokens", {
              used: formatBreakdownTokens(usedTokens),
              max: formatBreakdownTokens(maxTokens),
            })}
          </Text>
          {sessionCost ? (
            <Text style={styles.detail}>
              {t("contextWindow.sessionCost", { cost: sessionCost })}
            </Text>
          ) : null}
          {overLimit ? (
            <Text style={styles.detail}>
              {t("contextWindow.breakdown.overLimit", {
                tokens: formatBreakdownTokens(overLimit.tokensOver),
              })}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.legend}>
        {model.legend.map((row) => (
          <LegendRow key={row.key} row={row} />
        ))}
      </View>
      {view.kind === "ready" && view.breakdown.groups.length > 0 ? (
        <View style={styles.groups}>
          {view.breakdown.groups.map((group) => (
            <GroupRow key={group.id} group={group} interactive={interactive} />
          ))}
        </View>
      ) : null}
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

function breakdownNote(
  kind: ReturnType<typeof useContextBreakdown>["kind"],
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  switch (kind) {
    case "loading":
      return t("contextWindow.breakdown.loading");
    case "error":
      return t("contextWindow.breakdown.error");
    case "totals":
    case "unsupported":
      return t("contextWindow.breakdown.totalsOnly");
    case "ready":
      return null;
  }
}

function rowColor(theme: Theme, slot: number | null, kind: ContextRow["kind"]): string {
  if (slot !== null) return seriesColor(slot, theme.colorScheme);
  if (kind === "buffer") return theme.colors.foregroundMuted;
  return theme.colors.surface3;
}

// SVG strokes and icon colours are not styles, so they reach the theme through withUnistyles.
const ThemedCircle = withUnistyles(Circle);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const trackStroke = (theme: Theme) => ({ stroke: theme.colors.surface2 });
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function Arc({ row, length, offset }: { row: ContextRow; length: number; offset: number }) {
  const { slot, kind } = row;
  const stroke = useCallback(
    (theme: Theme) => ({ stroke: rowColor(theme, slot, kind) }),
    [slot, kind],
  );
  return (
    <ThemedCircle
      cx={DONUT_CENTER}
      cy={DONUT_CENTER}
      r={DONUT_RADIUS}
      fill="none"
      uniProps={stroke}
      strokeWidth={DONUT_STROKE}
      strokeDasharray={`${length} ${DONUT_CIRCUMFERENCE - length}`}
      // Dash offsets run backwards; SVG strokes start at three o'clock.
      strokeDashoffset={-offset}
      transform={`rotate(-90 ${DONUT_CENTER} ${DONUT_CENTER})`}
    />
  );
}

function Donut({ model, percentage }: { model: ContextBreakdownModel; percentage: number }) {
  const { t } = useTranslation();
  const arcs = useMemo(
    () =>
      layoutDonut({
        segments: model.segments,
        total: model.maxTokens,
        circumference: DONUT_CIRCUMFERENCE,
        gap: DONUT_GAP,
      }),
    [model],
  );
  const rows = new Map(model.segments.map((row) => [row.key, row]));
  return (
    <View
      style={styles.donut}
      accessibilityRole="image"
      accessibilityLabel={t("contextWindow.accessibility", { percentage })}
    >
      <Svg width={DONUT_SIZE} height={DONUT_SIZE} viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}>
        <ThemedCircle
          cx={DONUT_CENTER}
          cy={DONUT_CENTER}
          r={DONUT_RADIUS}
          fill="none"
          uniProps={trackStroke}
          strokeWidth={DONUT_STROKE}
        />
        {arcs.map((arc) => {
          const row = rows.get(arc.key);
          return row ? (
            <Arc key={arc.key} row={row} length={arc.length} offset={arc.offset} />
          ) : null;
        })}
      </Svg>
      <View style={styles.donutLabel} pointerEvents="none">
        <Text style={styles.donutPercent}>{`${percentage}%`}</Text>
      </View>
    </View>
  );
}

function LegendRow({ row }: { row: ContextRow }) {
  const deferred = row.kind === "deferred";
  return (
    <View style={styles.legendRow}>
      <View
        style={[
          styles.swatch,
          styles.swatchFill(row.slot, row.kind),
          (row.kind === "free" || deferred) && styles.swatchOutline,
        ]}
      />
      <Text style={[styles.legendLabel, deferred && styles.muted]} numberOfLines={1}>
        {row.label}
      </Text>
      <Text style={[styles.legendValue, deferred && styles.muted]}>
        {formatBreakdownTokens(row.tokens)}
      </Text>
      <Text style={[styles.legendPercent, deferred && styles.muted]}>
        {formatPercent(row.percentOfWindow)}
      </Text>
    </View>
  );
}

function useGroupLabel(id: string): string {
  const { t } = useTranslation();
  switch (id) {
    case "mcp_tools":
      return t("contextWindow.breakdown.groups.mcpTools");
    case "memory_files":
      return t("contextWindow.breakdown.groups.memoryFiles");
    case "skills":
      return t("contextWindow.breakdown.groups.skills");
    case "agents":
      return t("contextWindow.breakdown.groups.agents");
    default:
      return id;
  }
}

function GroupRow({ group, interactive }: { group: AgentContextGroup; interactive: boolean }) {
  const label = useGroupLabel(group.id);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const items = useMemo(() => [...group.items].sort((a, b) => b.tokens - a.tokens), [group.items]);
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  const header = (
    <>
      {interactive ? <Chevron size={12} uniProps={mutedIcon} /> : null}
      <Text style={styles.legendLabel}>{label}</Text>
      <Text style={styles.legendValue}>{group.items.length}</Text>
    </>
  );
  return (
    <View>
      {interactive ? (
        <Pressable
          style={styles.groupHeader}
          accessibilityRole="button"
          accessibilityState={accessibilityState}
          onPress={toggle}
          testID={`context-breakdown-group-${group.id}`}
        >
          {header}
        </Pressable>
      ) : (
        <View style={styles.groupHeader}>{header}</View>
      )}
      {open && interactive
        ? items.map((item) => (
            <View key={`${item.name}:${item.detail ?? ""}`} style={styles.itemRow}>
              <Text style={styles.itemLabel} numberOfLines={1}>
                {item.name}
              </Text>
              {/* Always rendered: it holds the space that right-aligns the token count. */}
              <Text style={styles.itemDetail} numberOfLines={1}>
                {item.detail ?? ""}
              </Text>
              <Text style={styles.legendValue}>{formatBreakdownTokens(item.tokens)}</Text>
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[3], minWidth: 220 },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  summaryText: { flex: 1, gap: theme.spacing[1] },
  headline: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  donut: { width: DONUT_SIZE, height: DONUT_SIZE },
  donutLabel: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  donutPercent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  legend: { gap: theme.spacing[1] },
  legendRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  swatchFill: (slot: number | null, kind: ContextRow["kind"]) => ({
    backgroundColor: rowColor(theme, slot, kind),
  }),
  swatchOutline: { borderWidth: 1, borderColor: theme.colors.border },
  legendLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  legendValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  legendPercent: {
    width: 48,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  muted: { color: theme.colors.foregroundMuted },
  groups: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 24,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    minHeight: 20,
  },
  itemLabel: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  itemDetail: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
