import { isDeepStrictEqual } from "node:util";
import {
  parseQuotaGovernorPolicy,
  QuotaObservationSchema,
  type QuotaConsumptionLimit,
  type QuotaGovernorPolicy,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";

function normalizedLimit(limit: QuotaConsumptionLimit): QuotaConsumptionLimit {
  if (limit.period.kind !== "calendar_day") return limit;
  return {
    ...limit,
    period: {
      kind: "calendar_day",
      timezone: new Intl.DateTimeFormat("en", { timeZone: limit.period.timezone }).resolvedOptions()
        .timeZone,
    },
  };
}

function intersectPrepaidAuthorization(
  parent: QuotaGovernorPolicy,
  child: QuotaGovernorPolicy,
): QuotaGovernorPolicy["prepaidAuthorization"] {
  const parentGrant = parent.prepaidAuthorization;
  const childGrant = child.prepaidAuthorization;
  if (!parentGrant || !childGrant) return undefined;
  const sameWindow =
    parentGrant.bucketId === childGrant.bucketId && parentGrant.windowId === childGrant.windowId;
  if (!sameWindow) throw new Error("Prepaid authorization windows require reconciliation.");
  const startsAt = Math.max(Date.parse(parentGrant.startsAt), Date.parse(childGrant.startsAt));
  const expiresAt = Math.min(Date.parse(parentGrant.expiresAt), Date.parse(childGrant.expiresAt));
  if (startsAt >= expiresAt) throw new Error("Prepaid authorizations do not overlap.");
  return {
    bucketId: parentGrant.bucketId,
    windowId: parentGrant.windowId,
    startsAt: new Date(startsAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** Combine obligations, never consumption totals. Incompatible meter semantics need migration. */
export function combineQuotaPolicies(
  parentInput: QuotaGovernorPolicy,
  childInput: QuotaGovernorPolicy,
): QuotaGovernorPolicy {
  const parent = parseQuotaGovernorPolicy(parentInput);
  const child = parseQuotaGovernorPolicy(childInput);
  const prepaidAuthorization = intersectPrepaidAuthorization(parent, child);
  if (!isDeepStrictEqual(parent.account, child.account)) throw new Error("Quota account mismatch.");
  const windows = new Map<string, QuotaGovernorPolicy["requiredWindows"][number]>();
  for (const window of [...parent.requiredWindows, ...child.requiredWindows]) {
    const key = JSON.stringify([window.bucketId, window.windowId]);
    const previous = windows.get(key);
    if (previous && !isDeepStrictEqual(previous, window))
      throw new Error("Quota window semantics require reconciliation.");
    windows.set(key, window);
  }
  const limits = new Map<string, QuotaConsumptionLimit>();
  let estimatedHourly = parent.estimatedHourly ?? child.estimatedHourly;
  if (parent.estimatedHourly && child.estimatedHourly) {
    if (
      parent.estimatedHourly.bucketId !== child.estimatedHourly.bucketId ||
      parent.estimatedHourly.windowId !== child.estimatedHourly.windowId
    )
      throw new Error("Estimated quota windows require reconciliation.");
    estimatedHourly = {
      ...parent.estimatedHourly,
      maxConsumedPoints: Math.min(
        parent.estimatedHourly.maxConsumedPoints,
        child.estimatedHourly.maxConsumedPoints,
      ),
    };
  }
  for (const input of [...parent.consumptionLimits, ...child.consumptionLimits]) {
    const limit = normalizedLimit(input);
    const key = JSON.stringify([limit.meterId, limit.period.kind]);
    const previous = limits.get(key);
    if (!previous) {
      limits.set(key, limit);
      continue;
    }
    const { throttleAt, holdAt, freezeAt, ...semantics } = limit;
    const {
      throttleAt: oldThrottle,
      holdAt: oldHold,
      freezeAt: oldFreeze,
      ...oldSemantics
    } = previous;
    if (!isDeepStrictEqual(semantics, oldSemantics))
      throw new Error("Quota consumption semantics require migration.");
    limits.set(key, {
      ...limit,
      throttleAt: Math.min(throttleAt, oldThrottle),
      holdAt: Math.min(holdAt, oldHold),
      freezeAt: Math.min(freezeAt, oldFreeze),
    });
  }
  const combined: QuotaGovernorPolicy = {
    ...parent,
    requiredWindows: [...windows.values()],
    launchFloorPercent: Math.max(parent.launchFloorPercent, child.launchFloorPercent),
    freezeFloorPercent: Math.max(parent.freezeFloorPercent, child.freezeFloorPercent),
    maxObservationAgeSeconds: Math.min(
      parent.maxObservationAgeSeconds,
      child.maxObservationAgeSeconds,
    ),
    consumptionLimits: [...limits.values()],
    prepaidAuthorization,
    ...(estimatedHourly ? { estimatedHourly } : {}),
  };
  if (!prepaidAuthorization) delete combined.prepaidAuthorization;
  return parseQuotaGovernorPolicy(combined);
}

/** Input must come from the trusted observer, never from a schedule or RPC request body. */
export function assertQuotaPolicyAccount(
  policyInput: QuotaGovernorPolicy,
  observationInput: QuotaObservation,
  nowMs: number,
): void {
  const policy = parseQuotaGovernorPolicy(policyInput);
  const observation = QuotaObservationSchema.parse(observationInput);
  if (observation.status !== "available" || !isDeepStrictEqual(observation.account, policy.account))
    throw new Error("Fresh authenticated account observation required.");
  const age = nowMs - Date.parse(observation.observedAt);
  if (!Number.isFinite(nowMs) || age < 0 || age > policy.maxObservationAgeSeconds * 1000)
    throw new Error("Fresh authenticated account observation required.");
  for (const required of policy.requiredWindows) {
    if (
      !observation.windows.some(
        (window) =>
          window.bucketId === required.bucketId &&
          window.windowId === required.windowId &&
          window.durationMinutes === required.durationMinutes,
      )
    )
      throw new Error("Required account window unavailable.");
  }
  // Configuration may record a currently blocked policy. Missing consumption
  // telemetry still prevents admission through the ordinary governor evaluator.
}
