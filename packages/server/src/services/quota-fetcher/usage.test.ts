import { describe, expect, it } from "vitest";
import {
  balanceToneFromRemaining,
  paceProjection,
  toneFromUsedPct,
  usedPctOf,
  windowFromUsedPct,
} from "./usage.js";

describe("toneFromUsedPct", () => {
  // Thresholds must match deriveTone in the app's provider-usage/tone.ts, which is what
  // the client applies when a window arrives without a tone.
  it.each([
    [0, "ok"],
    [69.9, "ok"],
    [70, "warning"],
    [90, "warning"],
    [90.1, "danger"],
    [100, "danger"],
    [150, "danger"],
  ])("%s%% used is %s", (usedPct, expected) => {
    expect(toneFromUsedPct(usedPct)).toBe(expected);
  });

  it("is neutral when the percentage is unknown", () => {
    expect(toneFromUsedPct(null)).toBe("default");
    expect(toneFromUsedPct(undefined)).toBe("default");
  });
});

describe("usedPctOf", () => {
  it("computes a percentage of the limit", () => {
    expect(usedPctOf(15.79, 42.5)).toBeCloseTo(37.15, 2);
  });

  it("is unknown when either side is missing", () => {
    expect(usedPctOf(null, 100)).toBeNull();
    expect(usedPctOf(50, null)).toBeNull();
  });

  // A zero limit would divide to Infinity and render as a full red bar.
  it("is unknown when the limit is zero or negative", () => {
    expect(usedPctOf(50, 0)).toBeNull();
    expect(usedPctOf(50, -1)).toBeNull();
  });
});

describe("balanceToneFromRemaining", () => {
  // Kept for balances with no limit, where no percentage can be computed. It only
  // escalates at exhaustion, which is why anything with a limit should use
  // toneFromUsedPct instead.
  it("stays ok until nothing is left", () => {
    expect(balanceToneFromRemaining(0.01)).toBe("ok");
    expect(balanceToneFromRemaining(0)).toBe("danger");
    expect(balanceToneFromRemaining(null)).toBe("default");
  });
});

describe("paceProjection", () => {
  const HOUR = 60 * 60_000;
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const resetIn = (ms: number) => new Date(now + ms).toISOString();

  it("projects when a 5-hour window runs out ahead of its reset", () => {
    // Two hours in, 60% used: 30% an hour, so the last 40% lasts 80 minutes.
    expect(
      paceProjection({ usedPct: 60, resetsAt: resetIn(3 * HOUR), windowMs: 5 * HOUR, now }),
    ).toEqual({ runsOutAt: new Date(now + 80 * 60_000).toISOString(), shortfallPct: 50 });
  });

  it("stays quiet when the window lasts until its reset", () => {
    expect(
      paceProjection({ usedPct: 30, resetsAt: resetIn(3 * HOUR), windowMs: 5 * HOUR, now }),
    ).toBeNull();
  });

  it("waits until enough of the window has elapsed to trust the rate", () => {
    expect(
      paceProjection({ usedPct: 20, resetsAt: resetIn(4.75 * HOUR), windowMs: 5 * HOUR, now }),
    ).toBeNull();
  });

  it("skips exhausted, idle, unknown or inconsistent windows", () => {
    const resetsAt = resetIn(2 * HOUR);
    expect(paceProjection({ usedPct: 100, resetsAt, windowMs: 5 * HOUR, now })).toBeNull();
    expect(paceProjection({ usedPct: 0, resetsAt, windowMs: 5 * HOUR, now })).toBeNull();
    expect(paceProjection({ usedPct: 80, resetsAt, windowMs: null, now })).toBeNull();
    expect(paceProjection({ usedPct: 80, resetsAt: null, windowMs: 5 * HOUR, now })).toBeNull();
    // A reset further away than the window is long means the length is wrong.
    expect(
      paceProjection({ usedPct: 80, resetsAt: resetIn(6 * HOUR), windowMs: 5 * HOUR, now }),
    ).toBeNull();
  });

  it("adds the projection to a window built from its used percent", () => {
    const window = windowFromUsedPct({
      id: "session",
      label: "5-hour",
      utilizationPct: 60,
      resetsAt: resetIn(3 * HOUR),
      windowMs: 5 * HOUR,
      now,
    });
    expect(window).toMatchObject({ remainingPct: 40, shortfallPct: 50 });
    expect(window.runsOutAt).toBe(new Date(now + 80 * 60_000).toISOString());
  });
});
