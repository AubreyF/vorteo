import { describe, expect, it } from "vitest";
import pino from "pino";
import type { UsageLimitHold } from "@getpaseo/protocol/usage-limit";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { StoredAgentRecord } from "../agent-storage.js";
import {
  CONTINUED_FROM_LABEL,
  readingFromProviderUsage,
  usageLimitContinuationText,
  UsageLimitResumeService,
  type AccountUsageReading,
} from "./resume-service.js";

const logger = pino({ level: "silent" });
const MINUTE = 60_000;
const T0 = Date.parse("2026-10-22T10:00:00.000Z");

function record(
  id: string,
  usageLimitHold: UsageLimitHold | undefined,
  extra: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  return {
    id,
    provider: "claude",
    labels: {},
    config: usageLimitHold ? { usageLimitHold } : {},
    ...extra,
  } as StoredAgentRecord;
}

function hold(overrides: Partial<UsageLimitHold> = {}): UsageLimitHold {
  return {
    stoppedAt: new Date(T0).toISOString(),
    resetsAt: new Date(T0 + 60 * MINUTE).toISOString(),
    attempts: 0,
    ...overrides,
  };
}

/** A daemon stand-in: holds live on stored records, and released threads record their prompt. */
function harness(
  records: StoredAgentRecord[],
  options: {
    reading?: AccountUsageReading;
    autoResume?: boolean;
    pausedQueues?: string[];
  } = {},
) {
  let now = T0;
  const released: Array<{ id: string; text: string }> = [];
  const readings: string[] = [];
  const byId = new Map(records.map((entry) => [entry.id, entry]));
  const update = async (
    id: string,
    change: (current: UsageLimitHold | undefined) => UsageLimitHold | null | undefined,
  ) => {
    const entry = byId.get(id)!;
    const next = change(entry.config?.usageLimitHold);
    if (next === undefined) return entry.config?.usageLimitHold ?? null;
    entry.config = { ...entry.config, usageLimitHold: next ?? undefined };
    return next;
  };
  const service = new UsageLimitResumeService({
    agentStorage: { list: async () => [...byId.values()] },
    agentManager: {
      isRestartDraining: () => false,
      updateUsageLimitHold: update,
      resumeAfterUsageLimit: async (id, { text }) => {
        if (options.pausedQueues?.includes(id)) return false;
        released.push({ id, text });
        return update(id, (current) =>
          current
            ? {
                ...current,
                attempts: current.attempts + 1,
                releasedAt: new Date(now).toISOString(),
              }
            : undefined,
        );
      },
    },
    readUsage: async (provider) => {
      readings.push(provider);
      return options.reading ?? { kind: "unknown" };
    },
    autoResumeEnabled: () => options.autoResume ?? true,
    logger,
    now: () => now,
  });
  return {
    service,
    released,
    readings,
    byId,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe("UsageLimitResumeService", () => {
  it("waits for the reported reset plus a grace period, then releases one thread per account at a time", async () => {
    const h = harness([
      record("first", hold()),
      record("second", hold({ stoppedAt: new Date(T0 + MINUTE).toISOString() })),
      record("codex-thread", hold(), { provider: "codex" } as Partial<StoredAgentRecord>),
    ]);

    h.at(T0 + 61 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);

    h.at(T0 + 62 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["first", "codex-thread"]);
    expect(h.readings).toEqual([]);

    // The next thread on the same account waits out the stagger.
    h.at(T0 + 63 * MINUTE);
    await h.service.tick();
    expect(h.released).toHaveLength(2);
    h.at(T0 + 64 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["first", "codex-thread", "second"]);
    expect(h.byId.get("first")?.config?.usageLimitHold).toMatchObject({ attempts: 1 });
  });

  it("skips threads that continue elsewhere, opted out, archived or owned by another controller", async () => {
    const h = harness([
      record("continued", hold()),
      record("successor", undefined, { labels: { [CONTINUED_FROM_LABEL]: "continued" } }),
      record("opted-out", hold({ optOut: true })),
      record("archived", hold(), { archivedAt: new Date(T0).toISOString() }),
      record("controlled", hold(), { owner: { kind: "daemon" } } as Partial<StoredAgentRecord>),
    ]);
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
  });

  it("leaves every thread waiting when the account's resume switch is off", async () => {
    const h = harness([record("thread", hold())], { autoResume: false });
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
  });

  it("asks the usage reader when a stop reported no reset, and adopts its reset time", async () => {
    const resetsAt = new Date(T0 + 5 * 60 * MINUTE).toISOString();
    const h = harness([record("codex", hold({ resetsAt: undefined }))], {
      reading: { kind: "limited", resetsAt },
    });
    h.at(T0 + 31 * MINUTE);
    await h.service.tick();
    expect(h.readings).toEqual(["claude"]);
    expect(h.released).toEqual([]);
    expect(h.byId.get("codex")?.config?.usageLimitHold?.resetsAt).toBe(resetsAt);
  });

  it("probes an account with no usage reading after a backoff", async () => {
    const h = harness([record("probe", hold({ resetsAt: undefined }))]);
    h.at(T0 + 29 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
    h.at(T0 + 30 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["probe"]);
  });

  it("stops after three automatic attempts and leaves the decision to the owner", async () => {
    const h = harness([record("stubborn", hold({ attempts: 3 }))]);
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released).toEqual([]);
    expect(h.byId.get("stubborn")?.config?.usageLimitHold).toMatchObject({ gaveUp: true });
  });

  it("passes over a paused queue and releases the next thread", async () => {
    const h = harness(
      [
        record("paused", hold()),
        record("ready", hold({ stoppedAt: new Date(T0 + MINUTE).toISOString() })),
      ],
      { pausedQueues: ["paused"] },
    );
    h.at(T0 + 3 * 60 * MINUTE);
    await h.service.tick();
    expect(h.released.map((entry) => entry.id)).toEqual(["ready"]);
    expect(h.byId.get("paused")?.config?.usageLimitHold?.releasedAt).toBeUndefined();
  });
});

describe("usage-limit helpers", () => {
  it("mentions a multi-day wait in the continuation", () => {
    const stop = hold();
    expect(usageLimitContinuationText(stop, { manual: false, now: T0 + 3 * 60 * MINUTE })).toBe(
      "Your previous turn stopped at a usage limit, which has now reset. Check what was already done, then continue the authorized work, following the owner's latest instructions.",
    );
    expect(
      usageLimitContinuationText(stop, { manual: false, now: T0 + 3 * 24 * 60 * MINUTE }),
    ).toContain("This thread waited 3 days for the reset");
    expect(usageLimitContinuationText(stop, { manual: true, now: T0 })).toMatch(
      /^The owner resumed this thread/,
    );
  });

  it("reads a used-up window as limited until its latest reset", () => {
    const usage = (windows: ProviderUsage["windows"]): ProviderUsage =>
      ({ providerId: "claude", status: "available", windows }) as ProviderUsage;
    const later = new Date(T0 + 7 * 24 * 60 * MINUTE).toISOString();
    expect(
      readingFromProviderUsage(
        usage([
          { id: "5h", label: "5h", usedPct: 100, resetsAt: new Date(T0 + MINUTE).toISOString() },
          { id: "wk", label: "Week", usedPct: 100, resetsAt: later },
        ]),
        T0,
      ),
    ).toEqual({ kind: "limited", resetsAt: later });
    expect(readingFromProviderUsage(usage([{ id: "5h", label: "5h", usedPct: 40 }]), T0)).toEqual({
      kind: "available",
    });
    expect(readingFromProviderUsage(undefined, T0)).toEqual({ kind: "unknown" });
  });
});
