import { formatProviderUsageCompactSummary } from "./compact-summary";
import { quotaReading } from "./quota-reading";
import type { ProviderUsageView } from "./types";

/** One account's quota as the sidebar card shows it. */
export interface QuotaRow {
  providerId: string;
  name: string;
  /** The limiting window's remaining percent, or null when it is unknown. */
  remaining: number | null;
  /** "42% · 3h", or a balance, when usage is known. */
  summary: string | null;
  /** Why usage is missing or old; null when the reading is current. */
  status: string | null;
  failing: boolean;
}

/** Remaining below this counts as constrained and sorts with failing accounts. */
export const LOW_QUOTA_PCT = 15;

/**
 * Every account that reports usage or a problem, failing ones first, then the least remaining.
 * Providers with no usage source and no problem are left out; they have nothing to show.
 */
export function quotaRows(view: ProviderUsageView, now: number): QuotaRow[] {
  if (view.kind !== "ready") return [];
  const rows: QuotaRow[] = [];
  for (const provider of view.payload.providers) {
    const reading = quotaReading(view, provider.providerId, now);
    const failing = Boolean(reading.authRecovery) || provider.status === "error";
    const summary = formatProviderUsageCompactSummary(provider);
    if (!failing && !summary && provider.status === "unavailable") continue;
    rows.push({
      providerId: provider.providerId,
      name: provider.displayName,
      remaining: reading.remaining,
      summary,
      status: failing
        ? (reading.statusLabel ?? provider.error ?? "Usage unavailable")
        : reading.statusLabel,
      failing,
    });
  }
  return rows.sort(compareRows);
}

/** How many accounts need attention: failing, or nearly out of quota. */
export function constrainedCount(rows: readonly QuotaRow[]): number {
  return rows.filter(
    (row) => row.failing || (row.remaining !== null && row.remaining < LOW_QUOTA_PCT),
  ).length;
}

function compareRows(left: QuotaRow, right: QuotaRow): number {
  if (left.failing !== right.failing) return left.failing ? -1 : 1;
  const leftRemaining = left.remaining ?? Number.POSITIVE_INFINITY;
  const rightRemaining = right.remaining ?? Number.POSITIVE_INFINITY;
  if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining;
  return left.name.localeCompare(right.name);
}
