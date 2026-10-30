import { describe, expect, it } from "vitest";
import { createOperationalTelemetry } from "./operational-telemetry.js";
import type {
  OperationalRecordInput,
  OperationalObservation,
} from "./operational-telemetry-record.js";
import type { OperationalAppendResult } from "./operational-telemetry-store.js";

function fixture(enabled = true) {
  let now = Date.UTC(2026, 9, 25);
  let monotonic = 0;
  let callback: (() => void) | null = null;
  let canceled = 0;
  let observations = 0;
  let failObservation = false;
  let failClock = false;
  let failSchedule = false;
  let write: (input: OperationalRecordInput) => Promise<OperationalAppendResult> = async () =>
    "written";
  const records: OperationalRecordInput[] = [];
  const observation: OperationalObservation = {
    coordinator: null,
    diskAvailableBytes: null,
    queues: null,
    hostConnection: null,
    devConnection: null,
  };
  const telemetry = createOperationalTelemetry({
    enabled,
    version: "0.11.0-beta.3.vorteo.844",
    clock: {
      now: () => {
        if (failClock) throw new Error("private clock sentinel");
        return now;
      },
      monotonic: () => monotonic,
    },
    observe() {
      observations++;
      if (failObservation) throw new Error("private observation sentinel");
      return observation;
    },
    writer: {
      async append(input) {
        records.push(input);
        return write(input);
      },
    },
    schedule(tick, interval) {
      if (failSchedule) throw new Error("private scheduling sentinel");
      expect(interval).toBe(60000);
      callback = tick;
      return () => {
        canceled++;
        callback = null;
      };
    },
  });
  return {
    telemetry,
    records,
    observations: () => observations,
    canceled: () => canceled,
    advance(ms: number) {
      now += ms;
      monotonic += ms;
    },
    tick() {
      callback?.();
    },
    setWrite(next: typeof write) {
      write = next;
    },
    failObservation() {
      failObservation = true;
    },
    setClockFailure(value: boolean) {
      failClock = value;
    },
    setScheduleFailure(value: boolean) {
      failSchedule = value;
    },
  };
}

describe("coordinator minute telemetry", () => {
  it("never resumes a stopped sampler when its pending write finishes", async () => {
    const f = fixture();
    let finish: ((value: OperationalAppendResult) => void) | undefined;
    const pending = new Promise<OperationalAppendResult>((resolve) => {
      finish = resolve;
    });
    f.setWrite(() => pending);
    const starting = f.telemetry.start();
    expect(f.records).toHaveLength(1);
    f.telemetry.stop();
    for (let minute = 0; minute < 100; minute++) {
      f.advance(60000);
      f.tick();
    }
    if (!finish) throw new Error("synthetic writer did not start");
    finish("written");
    await starting;
    expect(await f.telemetry.sample()).toBe("stopped");
    expect(f.observations()).toBe(1);
    expect(f.records).toHaveLength(1);
    expect(f.canceled()).toBe(1);
    const replacementWithoutOptIn = fixture(false);
    await replacementWithoutOptIn.telemetry.start();
    expect(replacementWithoutOptIn.records).toEqual([]);
    expect(replacementWithoutOptIn.observations()).toBe(0);
    replacementWithoutOptIn.telemetry.stop();
  });

  it("starts no scheduler, observation, write or event buffer without explicit opt-in", async () => {
    const f = fixture(false);
    await f.telemetry.start();
    f.telemetry.record({ atMs: 1, component: "host", phase: "running" });
    for (let minute = 0; minute < 100; minute++) {
      f.advance(60000);
      f.tick();
    }
    expect(await f.telemetry.sample()).toBe("stopped");
    expect(f.records).toEqual([]);
    expect(f.observations()).toBe(0);
    f.telemetry.stop();
    expect(f.canceled()).toBe(0);
  });

  it("can start again after scheduling fails without claiming an active sampler", async () => {
    const f = fixture();
    f.setScheduleFailure(true);
    await expect(f.telemetry.start()).rejects.toThrow("private scheduling sentinel");
    expect(await f.telemetry.sample()).toBe("stopped");
    f.setScheduleFailure(false);
    await f.telemetry.start();
    expect(f.records).toHaveLength(1);
    f.telemetry.stop();
  });

  it("recovers after an optional clock throws without leaving a permanently busy sampler", async () => {
    const f = fixture();
    await f.telemetry.start();
    f.setClockFailure(true);
    expect(await f.telemetry.sample()).toBe("not_written");
    f.setClockFailure(false);
    f.advance(60000);
    expect(await f.telemetry.sample()).toBe("written");
    expect(f.records).toHaveLength(2);
    expect(f.records[1].failedWrites).toBe(1);
    expect(JSON.stringify(f.records)).not.toContain("sentinel");
    f.telemetry.stop();
  });

  it("does nothing while fenced or stopped and starts only one scheduler", async () => {
    const f = fixture();
    expect(await f.telemetry.sample()).toBe("stopped");
    expect(f.observations()).toBe(0);
    await f.telemetry.start();
    await f.telemetry.start();
    expect(f.records).toHaveLength(1);
    f.telemetry.stop();
    f.tick();
    expect(await f.telemetry.sample()).toBe("stopped");
    expect(f.canceled()).toBe(1);
  });

  it("does not queue writes or observations behind an indefinitely slow write", async () => {
    const f = fixture();
    let finish: ((value: OperationalAppendResult) => void) | undefined;
    f.setWrite(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const initial = f.telemetry.start();
    for (let minute = 0; minute < 100; minute++) {
      f.advance(60000);
      f.tick();
    }
    expect(await f.telemetry.sample()).toBe("busy");
    expect(f.records).toHaveLength(1);
    expect(f.observations()).toBe(1);
    if (!finish) throw new Error("writer was not started");
    f.setWrite(async () => "written");
    finish("written");
    await initial;
    expect(await f.telemetry.sample()).toBe("written");
    expect(f.records[1].monotonicMs).toBe(6000000);
    expect(f.records[1].previous?.monotonicMs).toBe(0);
    f.telemetry.stop();
  });

  it("survives disk-full or denied writes, bounds events and never retains error messages", async () => {
    const f = fixture();
    f.setWrite(async () => {
      throw new Error("private ENOSPC sentinel");
    });
    await f.telemetry.start();
    for (let index = 0; index < 10000; index++)
      f.telemetry.record({ atMs: index, component: "host", phase: "running" });
    f.setWrite(async () => "written");
    f.advance(60000);
    expect(await f.telemetry.sample()).toBe("written");
    expect(f.records[1].failedWrites).toBe(1);
    expect(f.records[1].events).toHaveLength(32);
    expect(f.records[1].droppedEvents).toBe(9968);
    expect(JSON.stringify(f.records)).not.toContain("sentinel");
    f.telemetry.stop();
  });

  it("records missing observations and timer gaps instead of fabricating catch-up samples", async () => {
    const f = fixture();
    await f.telemetry.start();
    f.failObservation();
    f.advance(125000);
    expect(await f.telemetry.sample()).toBe("written");
    expect(f.records).toHaveLength(2);
    expect(f.records[1].observation).toBeNull();
    expect(f.records[1].monotonicMs).toBe(125000);
    expect(f.records[1].previous?.monotonicMs).toBe(0);
    f.telemetry.stop();
  });

  it("never retains arbitrary event strings or extra private fields in its minute buffer", async () => {
    const f = fixture();
    await f.telemetry.start();
    const event = {
      atMs: 1,
      component: "private component sentinel",
      phase: "private phase sentinel",
      get credential() {
        throw new Error("private event field must not be inspected");
      },
    };
    f.telemetry.record(event);
    f.advance(60000);
    expect(await f.telemetry.sample()).toBe("written");
    expect(JSON.stringify(f.records[1])).not.toContain("sentinel");
    f.telemetry.stop();
  });
});
