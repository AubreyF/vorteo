import { describe, expect, it } from "vitest";
import { createOperationalActivityBatch } from "./operational-telemetry-activity.js";
import type { OperationalEvent } from "./operational-telemetry-record.js";

function sink() {
  const events: OperationalEvent[] = [];
  let dropped = 0;
  return {
    events,
    dropped: () => dropped,
    record: (event: OperationalEvent) => {
      events.push(event);
    },
    recordDropped: (count: number) => {
      dropped += count;
    },
  };
}

describe("sanitized persisted lifecycle activity", () => {
  it("stages changed status and source phases without reading private job fields", () => {
    const output = sink();
    const batch = createOperationalActivityBatch();
    const next = {
      target: "host",
      status: "approved",
      sourceBatch: { status: "preparing" },
      get reason() {
        throw new Error("private reason must not be read");
      },
    };
    batch.change({ target: "host", status: "pending" }, next);
    expect(output.events).toHaveLength(0);
    batch.flush(output, () => 1000);
    expect(output.events).toEqual([
      { atMs: 1000, component: "host", phase: "approved" },
      { atMs: 1000, component: "source_update", phase: "preparing" },
    ]);
    batch.flush(output, () => 2000);
    expect(output.events).toHaveLength(2);
  });

  it("does not invent source preparation events for terminal or unchanged jobs", () => {
    const output = sink();
    const batch = createOperationalActivityBatch();
    const unchanged = { target: "host", status: "running" };
    batch.change(unchanged, unchanged);
    batch.change(unchanged, {
      target: "host",
      status: "failed",
      sourceBatch: { status: "preparing" },
    });
    batch.flush(output, () => 1000);
    expect(output.events).toEqual([{ atMs: 1000, component: "host", phase: "failed" }]);
  });

  it("bounds staged events and accounts for overflow without retaining arbitrary strings", () => {
    const output = sink();
    const batch = createOperationalActivityBatch();
    for (let i = 0; i < 10000; i++)
      batch.change(undefined, {
        target: "private target sentinel",
        status: "private status sentinel",
      });
    batch.flush(output, () => 1000);
    expect(output.events).toHaveLength(32);
    expect(output.dropped()).toBe(9968);
    expect(JSON.stringify(output.events)).not.toContain("sentinel");
    expect(output.events[0]).toEqual({ atMs: 1000, component: "maintenance", phase: "unknown" });
  });

  it("isolates optional clock and sink exceptions from the persisted lifecycle operation", () => {
    const output = sink();
    const batch = createOperationalActivityBatch();
    batch.change(undefined, { target: "container-daemon", status: "succeeded" });
    const failedClock = () => {
      throw new Error("private clock");
    };
    expect(() => batch.flush(output, failedClock)).not.toThrow();
    expect(output.events[0]).toEqual({ atMs: null, component: "dev", phase: "succeeded" });
    batch.change(undefined, { target: "host", status: "running" });
    const failedSink = {
      record() {
        throw new Error("private sink");
      },
      recordDropped() {},
    };
    const clock = () => 1;
    expect(() => batch.flush(failedSink, clock)).not.toThrow();
  });
});
