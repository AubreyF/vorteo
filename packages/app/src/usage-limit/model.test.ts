import type { UsageLimitHold } from "@getpaseo/protocol/usage-limit";
import { expect, it } from "vitest";
import { formatUsageLimitReset, usageLimitNotice } from "./model";

const clock = {
  now: new Date("2026-10-22T18:00:00.000Z"),
  timeZone: "America/Los_Angeles",
  locale: "en-US",
};

function hold(overrides: Partial<UsageLimitHold> = {}): UsageLimitHold {
  return { stoppedAt: "2026-10-22T17:00:00.000Z", attempts: 0, ...overrides };
}

it("names the reset time for a waiting thread and offers Don't resume", () => {
  expect(usageLimitNotice(hold({ resetsAt: "2026-10-22T23:10:00.000Z" }), clock)).toEqual({
    message: "Usage limit reached. Resumes after the limit resets at 4:10 PM.",
    canStopResume: true,
  });
});

it("adds the weekday and date when the reset is not today", () => {
  expect(usageLimitNotice(hold({ resetsAt: "2026-10-24T16:00:00.000Z" }), clock)?.message).toBe(
    "Usage limit reached. Resumes after the limit resets at Sat, Oct 24, 9:00 AM.",
  );
});

it("waits for room when the reset is unknown or already passed", () => {
  const waiting = "Usage limit reached. Resumes when the account has room again.";
  expect(usageLimitNotice(hold(), clock)).toEqual({ message: waiting, canStopResume: true });
  expect(usageLimitNotice(hold({ resetsAt: "2026-10-22T17:30:00.000Z" }), clock)?.message).toBe(
    waiting,
  );
  expect(formatUsageLimitReset("not a date", clock)).toBeNull();
});

it("explains an opted-out thread without offering Don't resume again", () => {
  expect(usageLimitNotice(hold({ optOut: true }), clock)).toEqual({
    message: "Usage limit reached. Automatic resume is off for this thread.",
    canStopResume: false,
  });
});

it("hands the thread back after repeated limits", () => {
  expect(usageLimitNotice(hold({ gaveUp: true, attempts: 3 }), clock)).toEqual({
    message: "Usage limit reached again after 3 automatic resumes. Continue when you're ready.",
    canStopResume: false,
  });
  expect(usageLimitNotice(hold({ gaveUp: true, attempts: 1 }), clock)?.message).toBe(
    "Usage limit reached again after 1 automatic resume. Continue when you're ready.",
  );
});

it("shows nothing once the thread has continued or was never held", () => {
  expect(usageLimitNotice(hold({ releasedAt: "2026-10-22T23:11:00.000Z" }), clock)).toBeNull();
  expect(usageLimitNotice(undefined, clock)).toBeNull();
});
