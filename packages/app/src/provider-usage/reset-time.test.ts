import { expect, it } from "vitest";
import { formatCountdown, formatResetMoment, formatUtcMoment } from "./reset-time";

const iso = "2026-10-23T23:10:00.000Z";

it("names the date, time and zone of a reset", () => {
  expect(formatResetMoment(iso, { timeZone: "America/Los_Angeles", locale: "en-US" })).toBe(
    "Fri Oct 23, 4:10 PM PDT",
  );
  // The same instant read after flying east lands on the next day.
  expect(formatResetMoment(iso, { timeZone: "Asia/Tokyo", locale: "en-US" })).toBe(
    "Sat Oct 24, 8:10 AM GMT+9",
  );
});

it("gives the UTC moment for the hover detail", () => {
  expect(formatUtcMoment(iso, "en-US")).toBe("Friday, October 23, 2026 at 11:10 PM UTC");
});

it("counts down in the two largest units and counts up once passed", () => {
  const at = Date.parse(iso);
  expect(formatCountdown(iso, at - (3 * 60 + 12) * 60_000)).toBe("3h 12m");
  expect(formatCountdown(iso, at - (2 * 24 + 9) * 3_600_000)).toBe("2d 9h");
  expect(formatCountdown(iso, at - 45 * 60_000)).toBe("45m");
  expect(formatCountdown(iso, at + 20 * 60_000)).toBe("20m ago");
});

it("ignores missing or invalid times", () => {
  expect(formatResetMoment(null)).toBeNull();
  expect(formatResetMoment("not a date")).toBeNull();
  expect(formatCountdown(undefined, 0)).toBeNull();
});
