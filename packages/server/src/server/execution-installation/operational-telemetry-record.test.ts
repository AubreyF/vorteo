import { describe, expect, it } from "vitest";
import {
  OPERATIONAL_RECORD_BYTES,
  OperationalRecordError,
  serializeOperationalRecord,
  retainedOperationalMinute,
  type OperationalRecordInput,
} from "./operational-telemetry-record.js";

function input(): OperationalRecordInput {
  return {
    nowMs: Date.UTC(2026, 9, 25, 12),
    monotonicMs: 125000,
    previous: {
      monotonicMs: 0,
      coordinator: {
        cpuUserMicros: 10,
        cpuSystemMicros: 5,
        rssBytes: 50,
        heapUsedBytes: 20,
        uptimeSeconds: 1,
      },
    },
    version: "0.11.0-beta.3.vorteo.844",
    observation: {
      coordinator: {
        cpuUserMicros: 30,
        cpuSystemMicros: 12,
        rssBytes: 60,
        heapUsedBytes: 25,
        uptimeSeconds: 126,
      },
      diskAvailableBytes: null,
      queues: null,
      hostConnection: null,
      devConnection: null,
    },
    events: [],
    droppedEvents: 0,
    failedWrites: 0,
  };
}

describe("private operational record", () => {
  it("keeps overflow accounting readable by the strict retained-record validator", () => {
    const source = input();
    const events = Array.from({ length: 100 }, () => ({
      atMs: source.nowMs,
      component: "host",
      phase: "running",
    }));
    const text = serializeOperationalRecord({
      ...source,
      events,
      droppedEvents: Number.MAX_SAFE_INTEGER,
    });
    expect(JSON.parse(text).droppedEvents).toBe(Number.MAX_SAFE_INTEGER);
    expect(retainedOperationalMinute(text)).toBe(Math.floor(source.nowMs / 60000));
  });

  it("excludes private fields without reading them and reports only process CPU deltas", () => {
    const source = input();
    const observation = {
      ...source.observation,
      coordinator: source.observation!.coordinator,
      diskAvailableBytes: null,
      queues: null,
      hostConnection: null,
      devConnection: null,
      get credential() {
        throw new Error("private field must never be inspected");
      },
      command: "private command sentinel",
      actor: "private actor sentinel",
    };
    const text = serializeOperationalRecord({ ...source, observation });
    const record = JSON.parse(text);
    expect(text).not.toContain("sentinel");
    expect(record.coordinator.cpuUserMicros).toBe(20);
    expect(record.coordinator.cpuSystemMicros).toBe(7);
    expect(record.scope).toBe("coordinator_process_and_cached_operations");
    expect(record.connections.host).toBeNull();
    expect(record.unavailableMetrics).toEqual([
      "aggregate_host_cpu",
      "host_memory_pressure",
      "host_swap",
    ]);
  });

  it("bounds event work and serialized disk bytes and counts discarded events", () => {
    const events = Array.from({ length: 10000 }, () => ({
      atMs: Date.UTC(2026, 9, 25),
      component: "host",
      phase: "running",
      reason: "private event sentinel",
    }));
    const text = serializeOperationalRecord({ ...input(), events });
    const record = JSON.parse(text);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(OPERATIONAL_RECORD_BYTES);
    expect(record.events.length).toBeLessThanOrEqual(32);
    expect(record.droppedEvents).toBe(10000 - record.events.length);
    expect(text).not.toContain("sentinel");
  });

  it("distinguishes a timer gap, a missing observation and an absent baseline", () => {
    const record = JSON.parse(serializeOperationalRecord(input()));
    expect(record.elapsedMs).toBe(125000);
    expect(record.missedIntervals).toBe(1);
    const missing = JSON.parse(
      serializeOperationalRecord({ ...input(), previous: null, observation: null }),
    );
    expect(missing.elapsedMs).toBeNull();
    expect(missing.missedIntervals).toBeNull();
    expect(missing.coordinator.rssBytes).toBeNull();
    expect(missing.resourceObservationAvailable).toBe(false);
  });

  it("refuses invalid clocks and excludes malformed status/version values", () => {
    expect(() => serializeOperationalRecord({ ...input(), nowMs: NaN })).toThrow(
      OperationalRecordError,
    );
    const source = input();
    const observation = source.observation!;
    const text = serializeOperationalRecord({
      ...source,
      version: "private version sentinel",
      observation: {
        ...observation,
        hostConnection: {
          status: "private status sentinel",
          observedAtMs: -1,
          authenticatedAtMs: null,
        },
      },
    });
    const record = JSON.parse(text);
    expect(record.version).toBeNull();
    expect(record.connections.host).toEqual({
      status: "not_observed",
      observedAtMs: null,
      authenticatedAtMs: null,
    });
    expect(text).not.toContain("sentinel");
  });
});
