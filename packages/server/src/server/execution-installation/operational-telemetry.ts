import {
  OPERATIONAL_EVENT_LIMIT,
  OPERATIONAL_INTERVAL_MS,
  sanitizeOperationalEvent,
  type OperationalEvent,
  type OperationalObservation,
  type OperationalRecordInput,
} from "./operational-telemetry-record.js";
import type { OperationalWriter } from "./operational-telemetry-store.js";

export interface OperationalClock {
  now(): number;
  monotonic(): number;
}

export interface OperationalTelemetryOptions {
  enabled: boolean;
  version: string;
  clock: OperationalClock;
  observe(): OperationalObservation;
  writer: OperationalWriter;
  schedule(callback: () => void, intervalMs: number): () => void;
}

export type OperationalTickResult = "written" | "not_written" | "busy" | "stopped";

export interface OperationalTelemetry {
  start(): Promise<void>;
  stop(): void;
  record(event: OperationalEvent): void;
  recordDropped(count: number): void;
  sample(): Promise<OperationalTickResult>;
}

function increment(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

/** A stalled writer occupies one operation, never a growing queue of minute samples. */
export function createOperationalTelemetry(
  options: OperationalTelemetryOptions,
): OperationalTelemetry {
  let cancel: (() => void) | null = null;
  let active = false;
  let writing = false;
  let previous: OperationalRecordInput["previous"] = null;
  let events: OperationalEvent[] = [];
  let droppedEvents = 0;
  let failedWrites = 0;

  async function sample(): Promise<OperationalTickResult> {
    if (!active) return "stopped";
    if (writing) return "busy";
    let nowMs: number;
    let monotonicMs: number;
    try {
      nowMs = options.clock.now();
      monotonicMs = options.clock.monotonic();
    } catch {
      failedWrites = increment(failedWrites);
      return "not_written";
    }
    writing = true;
    let observation: OperationalObservation | null = null;
    try {
      observation = options.observe();
    } catch {
      // Optional observation failure must not interrupt coordinator work or log private errors.
    }
    const selectedEvents = events;
    events = [];
    const selectedDrops = droppedEvents;
    droppedEvents = 0;
    try {
      const result = await options.writer.append({
        nowMs,
        monotonicMs,
        previous,
        version: options.version,
        observation,
        events: selectedEvents,
        droppedEvents: selectedDrops,
        failedWrites,
      });
      if (result !== "written") {
        droppedEvents = increment(droppedEvents, selectedEvents.length + selectedDrops);
        return "not_written";
      }
      previous = { monotonicMs, coordinator: observation?.coordinator ?? null };
      failedWrites = 0;
      return "written";
    } catch {
      failedWrites = increment(failedWrites);
      droppedEvents = increment(droppedEvents, selectedEvents.length + selectedDrops);
      return "not_written";
    } finally {
      writing = false;
    }
  }

  return {
    sample,
    async start() {
      if (!options.enabled) return;
      if (active) return;
      cancel = options.schedule(() => {
        void sample();
      }, OPERATIONAL_INTERVAL_MS);
      active = true;
      await sample();
    },
    stop() {
      active = false;
      cancel?.();
      cancel = null;
    },
    record(event) {
      if (!active) return;
      if (events.length === OPERATIONAL_EVENT_LIMIT) {
        events.shift();
        droppedEvents = increment(droppedEvents);
      }
      // Copy only the three intended primitives; never retain raw lifecycle objects.
      events.push(sanitizeOperationalEvent(event));
    },
    recordDropped(count) {
      if (active && Number.isSafeInteger(count) && count > 0)
        droppedEvents = increment(droppedEvents, count);
    },
  };
}
