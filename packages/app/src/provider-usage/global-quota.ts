import { clampPct } from "./format";
import { displayBalanceUnit, quotaReading } from "./quota-reading";
import type {
  ProviderUsage,
  ProviderUsageBalanceUnit,
  ProviderUsageDetail,
  ProviderUsageView,
  ProviderUsageWindow,
} from "./types";

/** One enforced window, drawn as its own bar. */
export interface QuotaWindowRow {
  id: string;
  label: string;
  /** A few characters for the collapsed account line, e.g. "5h" or "Opus". */
  summaryLabel: string;
  /** Percent left, or null when the provider omitted it. */
  remaining: number | null;
  resetsAt: string | null;
  /** When the current pace exhausts the window before it resets; null when on track. */
  runsOutAt: string | null;
  /** Code review has its own allowance and never stops ordinary agent work. */
  separate: boolean;
  /** The window that will stop work first, marked only when there is a choice. */
  limiting: boolean;
}

export interface QuotaBalanceRow {
  id: string;
  label: string;
  unit: ProviderUsageBalanceUnit;
  remaining: number | null;
  /** Only balances with a known limit get a bar. */
  limit: number | null;
  resetsAt: string | null;
}

/** One account's quota as the sidebar card shows it. */
export interface QuotaAccount {
  providerId: string;
  name: string;
  plan: string | null;
  source: string | null;
  /** Agents currently running on this account. */
  running: number;
  windows: QuotaWindowRow[];
  balances: QuotaBalanceRow[];
  details: ProviderUsageDetail[];
  /** The limiting window's remaining percent, else a capped balance's, else null. */
  remaining: number | null;
  /** Why usage is missing or old; null when the reading is current. */
  status: string | null;
  failing: boolean;
  disconnected: boolean;
  fetchedAt: string | null;
  /** The earliest reset still ahead, for the collapsed line. */
  nextResetAt: string | null;
  /** Failing, nearly out, or on pace to run out before a reset. */
  attention: boolean;
}

/** Remaining below this counts as constrained and sorts with failing accounts. */
export const LOW_QUOTA_PCT = 15;

/**
 * Every account that reports usage or a problem, those needing attention first, then the
 * least remaining. Providers with no usage source and no problem have nothing to show.
 */
export function quotaAccounts(view: ProviderUsageView, now: number): QuotaAccount[] {
  if (view.kind !== "ready") return [];
  const running = view.payload.workerActivity?.runningByProvider ?? {};
  const accounts: QuotaAccount[] = [];
  for (const provider of view.payload.providers) {
    const account = quotaAccount(view, provider, running[provider.providerId] ?? 0, now);
    if (account) accounts.push(account);
  }
  return accounts.sort(compareAccounts);
}

function quotaAccount(
  view: ProviderUsageView,
  provider: ProviderUsage,
  running: number,
  now: number,
): QuotaAccount | null {
  const reading = quotaReading(view, provider.providerId, now);
  const disconnected = Boolean(reading.authRecovery);
  const failing = disconnected || provider.status === "error";
  const windows = windowRows(provider, now);
  const balances = balanceRows(provider);
  if (!failing && provider.status === "unavailable" && !windows.length && !balances.length)
    return null;
  const remaining = limitingRemaining(windows, balances);
  const pacing = windows.some((window) => !window.separate && window.runsOutAt !== null);
  return {
    providerId: provider.providerId,
    name: provider.displayName,
    plan: provider.planLabel ?? null,
    source: provider.sourceLabel ?? null,
    running,
    windows,
    balances,
    details: provider.details ?? [],
    remaining,
    status: failing
      ? (reading.statusLabel ?? provider.error ?? "Usage unavailable")
      : healthyStatus(reading, remaining),
    failing,
    disconnected,
    fetchedAt: provider.fetchedAt ?? null,
    nextResetAt: nextReset(windows, now),
    attention: failing || pacing || (remaining !== null && remaining < LOW_QUOTA_PCT),
  };
}

/**
 * The shared reading only recognises windows that state a remaining percent, so a window
 * reporting just its used percent must not be called missing here.
 */
function healthyStatus(
  reading: ReturnType<typeof quotaReading>,
  remaining: number | null,
): string | null {
  if (reading.window || remaining === null) return reading.statusLabel;
  return null;
}

/** How many accounts need attention. */
export function attentionCount(accounts: readonly QuotaAccount[]): number {
  return accounts.filter((account) => account.attention).length;
}

function windowRemaining(window: ProviderUsageWindow): number | null {
  let value: number | null = null;
  if (typeof window.remainingPct === "number") value = window.remainingPct;
  else if (typeof window.usedPct === "number") value = 100 - window.usedPct;
  return value !== null && Number.isFinite(value) ? clampPct(value) : null;
}

function windowRows(usage: ProviderUsage, now: number): QuotaWindowRow[] {
  const rows = usage.windows.map((window): QuotaWindowRow => {
    const runsOutAt = window.runsOutAt ?? null;
    return {
      id: window.id,
      label: window.label,
      summaryLabel: summaryLabel(window),
      remaining: windowRemaining(window),
      resetsAt: window.resetsAt ?? null,
      // A projection that has already passed is stale, not a warning.
      runsOutAt: runsOutAt && Date.parse(runsOutAt) > now ? runsOutAt : null,
      separate: window.id === "code_review",
      limiting: false,
    };
  });
  const enforced = rows.filter((row) => !row.separate && row.remaining !== null);
  if (enforced.length > 1) {
    const lowest = enforced.reduce((low, row) => (row.remaining! < low.remaining! ? row : low));
    lowest.limiting = true;
  }
  return rows;
}

function balanceRows(usage: ProviderUsage): QuotaBalanceRow[] {
  return (usage.balances ?? []).map((balance) => {
    const limit = typeof balance.limit === "number" && balance.limit > 0 ? balance.limit : null;
    let remaining = typeof balance.remaining === "number" ? balance.remaining : null;
    if (remaining === null && limit !== null && typeof balance.used === "number")
      remaining = limit - balance.used;
    return {
      id: balance.id,
      label: balance.label,
      unit: displayBalanceUnit(usage.providerId, balance),
      remaining,
      limit,
      resetsAt: balance.resetsAt ?? null,
    };
  });
}

/** "5-hour" becomes "5h", "Weekly · Opus" becomes "Opus"; a provider's short label wins. */
export function summaryLabel(window: Pick<ProviderUsageWindow, "label" | "shortLabel">): string {
  if (window.shortLabel) return window.shortLabel;
  const duration = /^(\d+)-(hour|day|minute|second)$/.exec(window.label);
  if (duration) return `${duration[1]}${duration[2]![0]}`;
  const scoped = /^Weekly · (.+)$/.exec(window.label);
  if (scoped) return scoped[1]!;
  if (window.label === "Weekly") return "Week";
  return window.label;
}

function limitingRemaining(
  windows: readonly QuotaWindowRow[],
  balances: readonly QuotaBalanceRow[],
): number | null {
  const enforced = windows.filter((window) => !window.separate && window.remaining !== null);
  if (enforced.length) return Math.min(...enforced.map((window) => window.remaining!));
  const capped = balances.find((balance) => balance.limit !== null && balance.remaining !== null);
  return capped ? clampPct((100 * capped.remaining!) / capped.limit!) : null;
}

function nextReset(windows: readonly QuotaWindowRow[], now: number): string | null {
  let next: string | null = null;
  for (const window of windows) {
    if (window.separate || !window.resetsAt) continue;
    const at = Date.parse(window.resetsAt);
    if (at > now && (next === null || at < Date.parse(next))) next = window.resetsAt;
  }
  return next;
}

function compareAccounts(left: QuotaAccount, right: QuotaAccount): number {
  if (left.failing !== right.failing) return left.failing ? -1 : 1;
  if (left.attention !== right.attention) return left.attention ? -1 : 1;
  const leftRemaining = left.remaining ?? Number.POSITIVE_INFINITY;
  const rightRemaining = right.remaining ?? Number.POSITIVE_INFINITY;
  if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining;
  return left.name.localeCompare(right.name);
}
