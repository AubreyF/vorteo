import type { UsageLimitHold } from "@getpaseo/protocol/usage-limit";

export interface UsageLimitNotice {
  message: string;
  /** Don't resume only makes sense while the daemon still plans to continue the thread. */
  canStopResume: boolean;
}

export interface UsageLimitClock {
  now: Date;
  timeZone?: string;
  locale?: string;
}

/** What the thread shows while it waits at a usage limit, or null once it has continued. */
export function usageLimitNotice(
  hold: UsageLimitHold | undefined,
  clock: UsageLimitClock,
): UsageLimitNotice | null {
  if (!hold || hold.releasedAt) return null;
  if (hold.gaveUp) {
    const resumes =
      hold.attempts === 1 ? "1 automatic resume" : `${hold.attempts} automatic resumes`;
    return {
      message: `Usage limit reached again after ${resumes}. Continue when you're ready.`,
      canStopResume: false,
    };
  }
  if (hold.optOut) {
    return {
      message: "Usage limit reached. Automatic resume is off for this thread.",
      canStopResume: false,
    };
  }
  const reset = formatUsageLimitReset(hold.resetsAt, clock);
  const message = reset
    ? `Usage limit reached. Resumes after the limit resets at ${reset}.`
    : "Usage limit reached. Resumes when the account has room again.";
  return { message, canStopResume: true };
}

/** The reset time alone when it falls today, otherwise with its weekday and date. Null once passed. */
export function formatUsageLimitReset(
  iso: string | undefined,
  { now, timeZone, locale }: UsageLimitClock,
): string | null {
  if (!iso) return null;
  const reset = new Date(iso);
  if (!Number.isFinite(reset.getTime()) || reset.getTime() <= now.getTime()) return null;
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    dateStyle: "short",
  });
  const sameDay = dayKey.format(reset) === dayKey.format(now);
  const dateParts: Intl.DateTimeFormatOptions = sameDay
    ? {}
    : { weekday: "short", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    ...dateParts,
    hour: "numeric",
    minute: "2-digit",
  }).format(reset);
}
