import type { AgentContextBreakdown } from "@getpaseo/protocol/agent-context";

/**
 * Categorical slots from the data-viz reference palette, in fixed order, selected per mode.
 * Slot order passes adjacent-pair colour-vision checks in both modes, which is the pairing a
 * donut shows. A category keeps its slot by its position in the provider's list, so a row that
 * empties out does not repaint the rest.
 */
const SERIES_LIGHT = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
] as const;
const SERIES_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;

export type ContextRowKind = "used" | "buffer" | "free" | "deferred";

export interface ContextRow {
  key: string;
  label: string;
  tokens: number;
  kind: ContextRowKind;
  /** Share of the window, 0 to 100; null for deferred rows, which sit outside the window. */
  percentOfWindow: number | null;
  /** Series slot for used rows; null for buffer, free and deferred rows. */
  slot: number | null;
}

export interface ContextBreakdownModel {
  maxTokens: number;
  /** Rows the donut draws, in drawing order. Zero-token rows are omitted. */
  segments: ContextRow[];
  /** Legend rows: the segments, then deferred rows. */
  legend: ContextRow[];
}

function toKind(kind: string): ContextRowKind {
  return kind === "free" || kind === "buffer" || kind === "deferred" ? kind : "used";
}

function percentOf(tokens: number, maxTokens: number): number {
  return maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;
}

/** Order the donut reads clockwise from twelve: content, then the compaction reserve, then free. */
const KIND_ORDER: Record<ContextRowKind, number> = { used: 0, buffer: 1, free: 2, deferred: 3 };

/** Build donut segments and legend rows from a provider breakdown. */
export function buildBreakdownModel(breakdown: AgentContextBreakdown): ContextBreakdownModel {
  const { maxTokens } = breakdown;
  let nextSlot = 0;
  const rows = breakdown.categories.map((category, index): ContextRow => {
    const kind = toKind(category.kind);
    const slot = kind === "used" ? Math.min(nextSlot++, SERIES_LIGHT.length - 1) : null;
    return {
      key: `${index}:${category.name}`,
      label: category.name,
      tokens: category.tokens,
      kind,
      percentOfWindow: kind === "deferred" ? null : percentOf(category.tokens, maxTokens),
      slot,
    };
  });
  const segments = rows
    .filter((row) => row.kind !== "deferred" && row.tokens > 0)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const deferred = rows.filter((row) => row.kind === "deferred" && row.tokens > 0);
  return { maxTokens, segments, legend: [...segments, ...deferred] };
}

/** Two rows for providers that report totals only. */
export function buildTotalsModel(input: {
  usedTokens: number;
  maxTokens: number;
  usedLabel: string;
  freeLabel: string;
}): ContextBreakdownModel {
  const used = Math.max(0, input.usedTokens);
  const free = Math.max(0, input.maxTokens - used);
  const rows: ContextRow[] = [
    {
      key: "used",
      label: input.usedLabel,
      tokens: used,
      kind: "used",
      percentOfWindow: percentOf(used, input.maxTokens),
      slot: 0,
    },
    {
      key: "free",
      label: input.freeLabel,
      tokens: free,
      kind: "free",
      percentOfWindow: percentOf(free, input.maxTokens),
      slot: null,
    },
  ];
  const segments = rows.filter((row) => row.tokens > 0);
  return { maxTokens: input.maxTokens, segments, legend: rows };
}

export function seriesColor(slot: number, mode: "light" | "dark"): string {
  const palette = mode === "dark" ? SERIES_DARK : SERIES_LIGHT;
  return palette[Math.min(slot, palette.length - 1)];
}

export interface DonutArc {
  key: string;
  /** Arc length along the circumference. */
  length: number;
  /** Distance from twelve o'clock, clockwise, along the circumference. */
  offset: number;
}

/**
 * Lay segments around a circle, leaving `gap` between neighbours so adjacent fills stay
 * distinguishable. A segment smaller than the gap still shows as a sliver.
 */
export function layoutDonut(input: {
  segments: readonly Pick<ContextRow, "key" | "tokens">[];
  total: number;
  circumference: number;
  gap: number;
}): DonutArc[] {
  const { segments, circumference } = input;
  const total = Math.max(
    input.total,
    segments.reduce((sum, segment) => sum + segment.tokens, 0),
  );
  if (total <= 0 || segments.length === 0) return [];
  const gap = segments.length > 1 ? input.gap : 0;
  let offset = 0;
  return segments.map((segment) => {
    const span = (segment.tokens / total) * circumference;
    const arc = { key: segment.key, length: Math.max(0.5, span - gap), offset: offset + gap / 2 };
    offset += span;
    return arc;
  });
}

/** Token counts with one decimal below 100k, like Claude's /context table. */
export function formatBreakdownTokens(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}m`;
  if (value >= 100_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}k`;
  return Math.round(value).toString();
}

export function formatPercent(value: number | null): string {
  // Deferred rows sit outside the window, so they have no share of it.
  if (value === null) return "";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

function trimDecimal(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
