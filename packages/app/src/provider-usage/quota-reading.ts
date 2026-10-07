import { formatAmount } from "./format";
import type { ProviderUsage, ProviderUsageView } from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

/** Code review has a separate allowance and must not limit ordinary agent work. */
export function limitingWindow(usage: ProviderUsage | undefined) {
  if (!usage || usage.authRecovery || usage.status !== "available") return null;
  return (
    usage.windows
      .filter(
        (window): window is typeof window & { remainingPct: number } =>
          window.id !== "code_review" &&
          typeof window.remainingPct === "number" &&
          Number.isFinite(window.remainingPct) &&
          window.remainingPct >= 0 &&
          window.remainingPct <= 100,
      )
      .sort((left, right) => left.remainingPct - right.remainingPct)[0] ?? null
  );
}

export function quotaReading(view: ProviderUsageView, providerId: string | undefined, now: number) {
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((entry) => entry.providerId === providerId)
      : undefined;
  const window = limitingWindow(usage);
  const fetchedAt =
    usage?.fetchedAt ?? (view.kind === "ready" ? view.payload.fetchedAt : undefined);
  const age = fetchedAt ? now - Date.parse(fetchedAt) : NaN;
  const stale = !Number.isFinite(age) || age < 0 || age > PROVIDER_USAGE_STALE_TIME_MS;
  const issue = view.kind === "ready" ? (view.refreshError ?? usage?.refreshError) : undefined;
  let statusLabel: string | null = null;
  if (usage?.authRecovery) statusLabel = "Account disconnected";
  else if (!window) statusLabel = view.kind === "loading" ? "Loading usage" : "Usage unavailable";
  else if (issue) statusLabel = "Last known usage; refresh unavailable";
  else if (stale) statusLabel = "Last known usage";
  const remaining = window?.remainingPct ?? null;
  const prepaidLabel = prepaidBalanceLabel(usage, remaining);
  return {
    prepaidLabel,
    usage,
    authRecovery: usage?.authRecovery,
    window,
    remaining,
    statusLabel,
  };
}

function prepaidBalanceLabel(
  usage: ProviderUsage | undefined,
  remaining: number | null,
): string | null {
  if (!usage || remaining !== 0) return null;
  const balance = usage.balances?.find(
    (entry) =>
      entry.unit !== "requests" &&
      typeof entry.remaining === "number" &&
      Number.isFinite(entry.remaining) &&
      entry.remaining > 0,
  );
  if (balance && typeof balance.remaining === "number") {
    let unit = balance.unit;
    // COMPAT(codexCreditUnit): added in v0.11.0-beta.3.vorteo.165; remove after 2027-04-07 once daemon floor includes the credit-unit correction.
    const legacyCodexCredits =
      (usage.providerId === "codex" || usage.providerId.startsWith("codex-")) &&
      balance.id === "credits" &&
      unit === "usd";
    if (legacyCodexCredits) unit = "credits";
    const label = unit === "usd" ? "credit" : unit;
    const amount =
      unit === "tokens"
        ? balance.remaining.toLocaleString()
        : formatAmount(balance.remaining, unit);
    return `${amount} ${label} left`;
  }
  return null;
}
