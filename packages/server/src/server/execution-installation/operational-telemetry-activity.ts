import {
  OPERATIONAL_EVENT_LIMIT,
  sanitizeOperationalEvent,
  type OperationalEvent,
} from "./operational-telemetry-record.js";

interface ActivityState {
  target: string;
  status: string;
  sourceBatch?: { status: string };
  updatePreparation?: string;
}

export interface OperationalActivitySink {
  record(event: OperationalEvent): void;
  recordDropped(count: number): void;
}

/** Stage only fixed labels; publish after the existing lifecycle write succeeds. */
export function createOperationalActivityBatch() {
  const events: OperationalEvent[] = [];
  let dropped = 0;
  function add(component: string, phase: string) {
    if (events.length === OPERATIONAL_EVENT_LIMIT) {
      events.shift();
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
    }
    events.push(sanitizeOperationalEvent({ atMs: null, component, phase }));
  }
  return {
    change(previous: ActivityState | undefined, next: ActivityState) {
      let component = "maintenance";
      if (next.target === "host") component = "host";
      if (next.target === "container-daemon") component = "dev";
      if (!previous || previous.status !== next.status) add(component, next.status);
      const active = ["pending", "approved", "running"].includes(next.status);
      if (active && next.sourceBatch && previous?.sourceBatch?.status !== next.sourceBatch.status)
        add("source_update", next.sourceBatch.status);
      if (
        active &&
        next.updatePreparation &&
        previous?.updatePreparation !== next.updatePreparation
      )
        add("source_update", next.updatePreparation);
    },
    flush(sink: OperationalActivitySink, now: () => number) {
      let atMs: number | null = null;
      try {
        atMs = now();
      } catch {
        /* Optional clock does not affect lifecycle custody. */
      }
      try {
        for (const event of events) sink.record({ ...event, atMs });
        sink.recordDropped(dropped);
      } catch {
        // Optional telemetry must never change the outcome of an already persisted operation.
      }
      events.length = 0;
      dropped = 0;
    },
  };
}
