import { z } from "zod";

export const OPERATIONAL_RECORD_BYTES = 4096;
export const OPERATIONAL_EVENT_LIMIT = 32;
export const OPERATIONAL_INTERVAL_MS = 60_000;
const EVENT_COMPONENTS = new Set(["coordinator", "host", "dev", "source_update", "maintenance"]);
const EVENT_PHASES = new Set([
  "pending",
  "approved",
  "preparing",
  "building",
  "validating",
  "running",
  "connected",
  "disconnected",
  "succeeded",
  "failed",
  "canceled",
  "rejected",
  "waiting",
  "ready",
  "conflict",
  "prepared",
]);

const storedQuantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const storedTimestamp = z.number().int().nonnegative().max(8_640_000_000_000_000).nullable();
const storedConnection = z
  .strictObject({
    status: z.enum(["connecting", "connected", "disconnected", "not_observed"]),
    observedAtMs: storedTimestamp,
    authenticatedAtMs: storedTimestamp,
  })
  .nullable();
const storedRecord = z.strictObject({
  format: z.literal("vorteo-operational-v1"),
  sampledAt: z.string().datetime(),
  minute: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  version: z
    .string()
    .max(96)
    .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
    .nullable(),
  elapsedMs: z.number().finite().nonnegative().nullable(),
  missedIntervals: storedQuantity,
  scope: z.literal("coordinator_process_and_cached_operations"),
  coordinator: z.strictObject({
    cpuUserMicros: storedQuantity,
    cpuSystemMicros: storedQuantity,
    rssBytes: storedQuantity,
    heapUsedBytes: storedQuantity,
    uptimeSeconds: z.number().finite().nonnegative().nullable(),
  }),
  diskAvailableBytes: storedQuantity,
  unavailableMetrics: z.tuple([
    z.literal("aggregate_host_cpu"),
    z.literal("host_memory_pressure"),
    z.literal("host_swap"),
  ]),
  queues: z
    .strictObject({
      hostPending: storedQuantity,
      hostRunning: storedQuantity,
      devPending: storedQuantity,
      devRunning: storedQuantity,
      sourceUpdatesRunning: storedQuantity,
      maintenancePending: storedQuantity,
      maintenanceRunning: storedQuantity,
    })
    .nullable(),
  connections: z.strictObject({
    scope: z.literal("coordinator_to_daemon_transport_only"),
    host: storedConnection,
    dev: storedConnection,
  }),
  events: z
    .array(
      z.strictObject({
        atMs: storedTimestamp,
        component: z.string().refine((value) => value === "unknown" || EVENT_COMPONENTS.has(value)),
        phase: z.string().refine((value) => value === "unknown" || EVENT_PHASES.has(value)),
      }),
    )
    .max(OPERATIONAL_EVENT_LIMIT),
  droppedEvents: storedQuantity,
  failedWrites: storedQuantity,
  resourceObservationAvailable: z.boolean(),
});

/** Recognize every retained record before the store may append or rotate it. */
export function retainedOperationalMinute(line: string): number | null {
  try {
    const value: unknown = JSON.parse(line);
    // Our writer emits JSON.stringify records. Reject any other representation
    // before schema parsing can conceal duplicate keys and their retained bytes.
    const canonical = JSON.stringify(value);
    if (canonical !== line && canonical + "\n" !== line) return null;
    const parsed = storedRecord.safeParse(value);
    if (!parsed.success) return null;
    const record = parsed.data;
    return Math.floor(Date.parse(record.sampledAt) / OPERATIONAL_INTERVAL_MS) === record.minute
      ? record.minute
      : null;
  } catch {
    return null;
  }
}

export interface CoordinatorResourceObservation {
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rssBytes: number;
  heapUsedBytes: number;
  uptimeSeconds: number;
}

export interface OperationalQueueObservation {
  hostPending: number;
  hostRunning: number;
  devPending: number;
  devRunning: number;
  sourceUpdatesRunning: number;
  maintenancePending: number;
  maintenanceRunning: number;
}

export interface OperationalConnectionObservation {
  status: string;
  observedAtMs: number | null;
  authenticatedAtMs: number | null;
}

export interface OperationalObservation {
  coordinator: CoordinatorResourceObservation | null;
  diskAvailableBytes: number | null;
  queues: OperationalQueueObservation | null;
  hostConnection: OperationalConnectionObservation | null;
  devConnection: OperationalConnectionObservation | null;
}

export interface OperationalEvent {
  atMs: number | null;
  component: string;
  phase: string;
}

export interface OperationalRecordInput {
  nowMs: number;
  monotonicMs: number;
  previous: {
    monotonicMs: number;
    coordinator: CoordinatorResourceObservation | null;
  } | null;
  version: string;
  observation: OperationalObservation | null;
  events: readonly OperationalEvent[];
  droppedEvents: number;
  failedWrites: number;
}

export class OperationalRecordError extends Error {
  constructor(readonly code: "invalid_clock" | "oversized_record") {
    super("Operational telemetry record is unavailable.");
    this.name = "OperationalRecordError";
  }
}

function quantity(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function timestamp(value: number | null | undefined): number | null {
  const result = quantity(value);
  if (result === null || result > 8_640_000_000_000_000) return null;
  return result;
}

function cpuDelta(current: number | undefined, previous: number | undefined): number | null {
  const next = quantity(current);
  const before = quantity(previous);
  if (next === null || before === null || next < before) return null;
  return next - before;
}

function connection(value: OperationalConnectionObservation | null | undefined) {
  if (!value) return null;
  const statuses = ["connecting", "connected", "disconnected", "not_observed"];
  return {
    status: statuses.includes(value.status) ? value.status : "not_observed",
    observedAtMs: timestamp(value.observedAtMs),
    authenticatedAtMs: timestamp(value.authenticatedAtMs),
  };
}

export function sanitizeOperationalEvent(value: OperationalEvent): OperationalEvent {
  return {
    atMs: timestamp(value.atMs),
    component: EVENT_COMPONENTS.has(value.component) ? value.component : "unknown",
    phase: EVENT_PHASES.has(value.phase) ? value.phase : "unknown",
  };
}

function coordinatorResources(
  current: CoordinatorResourceObservation | null | undefined,
  previous: CoordinatorResourceObservation | null | undefined,
) {
  return {
    cpuUserMicros: cpuDelta(current?.cpuUserMicros, previous?.cpuUserMicros),
    cpuSystemMicros: cpuDelta(current?.cpuSystemMicros, previous?.cpuSystemMicros),
    rssBytes: quantity(current?.rssBytes),
    heapUsedBytes: quantity(current?.heapUsedBytes),
    uptimeSeconds:
      typeof current?.uptimeSeconds === "number" &&
      Number.isFinite(current.uptimeSeconds) &&
      current.uptimeSeconds >= 0
        ? current.uptimeSeconds
        : null,
  };
}

/** Serialize only operational primitives, never raw jobs, accounts or exceptions. */
export function serializeOperationalRecord(input: OperationalRecordInput): string {
  const now = timestamp(input.nowMs);
  if (now === null || !Number.isFinite(input.monotonicMs) || input.monotonicMs < 0)
    throw new OperationalRecordError("invalid_clock");
  const current = input.observation?.coordinator;
  const previous = input.previous?.coordinator;
  const queues = input.observation?.queues;
  let elapsedMs: number | null = null;
  if (input.previous && input.monotonicMs >= input.previous.monotonicMs)
    elapsedMs = input.monotonicMs - input.previous.monotonicMs;
  const events = input.events.slice(-OPERATIONAL_EVENT_LIMIT).map(sanitizeOperationalEvent);
  const record = {
    format: "vorteo-operational-v1",
    sampledAt: new Date(now).toISOString(),
    minute: Math.floor(now / OPERATIONAL_INTERVAL_MS),
    version:
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.version) && input.version.length <= 96
        ? input.version
        : null,
    elapsedMs,
    missedIntervals:
      elapsedMs === null ? null : Math.max(0, Math.floor(elapsedMs / OPERATIONAL_INTERVAL_MS) - 1),
    scope: "coordinator_process_and_cached_operations",
    coordinator: coordinatorResources(current, previous),
    diskAvailableBytes: quantity(input.observation?.diskAvailableBytes),
    unavailableMetrics: ["aggregate_host_cpu", "host_memory_pressure", "host_swap"],
    queues: queues
      ? {
          hostPending: quantity(queues.hostPending),
          hostRunning: quantity(queues.hostRunning),
          devPending: quantity(queues.devPending),
          devRunning: quantity(queues.devRunning),
          sourceUpdatesRunning: quantity(queues.sourceUpdatesRunning),
          maintenancePending: quantity(queues.maintenancePending),
          maintenanceRunning: quantity(queues.maintenanceRunning),
        }
      : null,
    connections: {
      scope: "coordinator_to_daemon_transport_only",
      host: connection(input.observation?.hostConnection),
      dev: connection(input.observation?.devConnection),
    },
    events,
    droppedEvents: Math.min(
      Number.MAX_SAFE_INTEGER,
      (quantity(input.droppedEvents) ?? 0) + input.events.length - events.length,
    ),
    failedWrites: quantity(input.failedWrites),
    resourceObservationAvailable: input.observation !== null,
  };
  let serialized = JSON.stringify(record) + "\n";
  while (Buffer.byteLength(serialized) > OPERATIONAL_RECORD_BYTES && events.length) {
    events.shift();
    record.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, record.droppedEvents + 1);
    serialized = JSON.stringify(record) + "\n";
  }
  if (Buffer.byteLength(serialized) > OPERATIONAL_RECORD_BYTES)
    throw new OperationalRecordError("oversized_record");
  return serialized;
}
