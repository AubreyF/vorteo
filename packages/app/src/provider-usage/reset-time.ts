const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * A reset as an absolute moment, "Thu Oct 23, 4:10 PM PDT", always with the zone so the
 * reading stays unambiguous after the device changes time zone.
 */
export function formatResetMoment(
  iso: string | null | undefined,
  options: { timeZone?: string; locale?: string } = {},
): string | null {
  const date = validDate(iso);
  if (!date) return null;
  const { timeZone, locale } = options;
  const day = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  })
    .format(date)
    .replace(",", "");
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `${day}, ${time}`;
}

/** The same moment in UTC with the year, for the hover detail. */
export function formatUtcMoment(iso: string | null | undefined, locale?: string): string | null {
  const date = validDate(iso);
  if (!date) return null;
  return `${new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    dateStyle: "full",
    timeStyle: "short",
  }).format(date)} UTC`;
}

/** "3h 12m", "2d 9h" or "45m" until the moment; "12m ago" once it has passed. */
export function formatCountdown(iso: string | null | undefined, now: number): string | null {
  const date = validDate(iso);
  if (!date) return null;
  const diff = date.getTime() - now;
  const span = Math.abs(diff);
  const days = Math.floor(span / DAY);
  const hours = Math.floor((span % DAY) / HOUR);
  const minutes = Math.floor((span % HOUR) / MINUTE);
  let text = `${minutes}m`;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${minutes}m`;
  return diff < 0 ? `${text} ago` : text;
}
