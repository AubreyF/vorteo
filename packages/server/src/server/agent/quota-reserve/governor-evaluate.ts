import {
  parseQuotaGovernorPolicy,
  QuotaObservationSchema,
  type QuotaConsumptionLimit,
  type QuotaConsumptionMeter,
  type QuotaGovernorPolicy,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";

export interface QuotaGovernorReason {
  code:
    | "invalid_policy"
    | "invalid_observation"
    | "account_changed"
    | "telemetry_stale"
    | "telemetry_unavailable"
    | "launch_floor"
    | "freeze_floor"
    | "meter_unavailable"
    | "meter_invalid"
    | "meter_coverage"
    | "consumption_throttle"
    | "consumption_hold"
    | "consumption_freeze"
    | "estimate_unavailable"
    | "estimated_hourly_limit"
    | "prepaid_authorization_inactive"
    | "required_window_unavailable";
  bucketId?: string;
  windowId?: string;
  meterId?: string;
  consumed?: number;
}

export interface QuotaGovernorDecision {
  action: "admit" | "throttle" | "hold" | "freeze";
  reasons: QuotaGovernorReason[];
}

interface EvaluationInput {
  policy: QuotaGovernorPolicy;
  observation: QuotaObservation;
  nowMs: number;
  phase: "admission" | "active";
}

/** Pure decision: callers must persist admission/freeze intent before starting inference. */
export function evaluateQuotaGovernor(input: EvaluationInput): QuotaGovernorDecision {
  const unavailable = (reason: QuotaGovernorReason): QuotaGovernorDecision => ({
    action: input.phase === "active" ? "freeze" : "hold",
    reasons: [reason],
  });
  let policy: QuotaGovernorPolicy;
  try {
    policy = parseQuotaGovernorPolicy(input.policy);
  } catch {
    return unavailable({ code: "invalid_policy" });
  }
  const parsed = QuotaObservationSchema.safeParse(input.observation);
  if (!parsed.success) return unavailable({ code: "invalid_observation" });
  const observation = parsed.data;
  if (observation.status !== "available") return unavailable({ code: "telemetry_unavailable" });
  if (
    observation.account.issuer !== policy.account.issuer ||
    observation.account.accountId !== policy.account.accountId
  ) {
    return unavailable({ code: "account_changed" });
  }
  const observedAt = Date.parse(observation.observedAt);
  if (observationExpired(observedAt, input.nowMs, policy.maxObservationAgeSeconds)) {
    return unavailable({ code: "telemetry_stale" });
  }
  for (const required of policy.requiredWindows) {
    if (
      !observation.windows.some(
        (window) =>
          window.bucketId === required.bucketId &&
          window.windowId === required.windowId &&
          window.durationMinutes === required.durationMinutes,
      )
    ) {
      return unavailable({
        code: "required_window_unavailable",
        bucketId: required.bucketId,
        windowId: required.windowId,
      });
    }
  }
  const decision: QuotaGovernorDecision = { action: "admit", reasons: [] };
  const ranks = { admit: 0, throttle: 1, hold: 2, freeze: 3 };
  const restrict = (action: QuotaGovernorDecision["action"], reason: QuotaGovernorReason) => {
    if (ranks[action] > ranks[decision.action]) decision.action = action;
    decision.reasons.push(reason);
  };
  const unknown = (reason: QuotaGovernorReason) =>
    restrict(input.phase === "active" ? "freeze" : "hold", reason);
  if (prepaidAuthorizationInactive(policy, input.nowMs))
    unknown({ code: "prepaid_authorization_inactive" });
  evaluateAllowanceWindows(policy, observation, restrict, unknown);
  for (const limit of policy.consumptionLimits) {
    const meter = matchingMeter(observation.consumptionMeters, limit);
    if (!meter) {
      unknown({ code: "meter_unavailable", meterId: limit.meterId });
      continue;
    }
    const consumption = readConsumption({ meter, limit, nowMs: input.nowMs, observedAt });
    if (consumption.status !== "available") {
      unknown({ code: consumption.status, meterId: limit.meterId });
      continue;
    }
    const fields = { meterId: limit.meterId, consumed: consumption.consumed };
    if (consumption.consumed >= limit.freezeAt)
      restrict("freeze", { code: "consumption_freeze", ...fields });
    else if (consumption.consumed >= limit.holdAt)
      restrict("hold", { code: "consumption_hold", ...fields });
    else if (consumption.consumed >= limit.throttleAt)
      restrict("throttle", { code: "consumption_throttle", ...fields });
  }
  const estimateReason = evaluateEstimate(policy, observation, input.nowMs);
  if (estimateReason?.code === "estimate_unavailable") unknown(estimateReason);
  else if (estimateReason) restrict("freeze", estimateReason);
  return decision;
}

function prepaidAuthorizationInactive(policy: QuotaGovernorPolicy, nowMs: number): boolean {
  const prepaid = policy.prepaidAuthorization;
  if (!prepaid) return false;
  return nowMs < Date.parse(prepaid.startsAt) || nowMs >= Date.parse(prepaid.expiresAt);
}

function evaluateEstimate(
  policy: QuotaGovernorPolicy,
  observation: Extract<QuotaObservation, { status: "available" }>,
  nowMs: number,
): QuotaGovernorReason | null {
  if (!policy.estimatedHourly) return null;
  const prepaid = policy.prepaidAuthorization;
  const prepaidEstimate =
    prepaid &&
    prepaid.bucketId === policy.estimatedHourly.bucketId &&
    prepaid.windowId === policy.estimatedHourly.windowId;
  if (prepaidEstimate) return null;
  const estimate = observation.estimatedHourlyUsage;
  if (
    !estimate ||
    estimate.bucketId !== policy.estimatedHourly.bucketId ||
    estimate.windowId !== policy.estimatedHourly.windowId ||
    estimate.consumedPoints === null ||
    estimate.observedAt !== observation.observedAt ||
    Date.parse(estimate.coverageStart) > nowMs - 3_600_000
  )
    return { code: "estimate_unavailable" };
  return estimate.consumedPoints >= policy.estimatedHourly.maxConsumedPoints
    ? { code: "estimated_hourly_limit", consumed: estimate.consumedPoints }
    : null;
}

function evaluateAllowanceWindows(
  policy: QuotaGovernorPolicy,
  observation: Extract<QuotaObservation, { status: "available" }>,
  restrict: (action: QuotaGovernorDecision["action"], reason: QuotaGovernorReason) => void,
  unknown: (reason: QuotaGovernorReason) => void,
): void {
  const windows = new Set<string>();
  for (const window of observation.windows) {
    // Keep every short/long window in the executing model's buckets.
    if (!policy.requiredWindows.some((required) => required.bucketId === window.bucketId)) continue;
    const identity = JSON.stringify([window.bucketId, window.windowId]);
    if (windows.has(identity)) {
      unknown({ code: "invalid_observation" });
      continue;
    }
    windows.add(identity);
    const prepaid = policy.prepaidAuthorization;
    const prepaidWindow =
      prepaid &&
      window.bucketId === prepaid.bucketId &&
      window.windowId === prepaid.windowId &&
      window.durationMinutes === 10080;
    if (prepaidWindow) continue;
    const remaining = 100 - window.usedPercent;
    const identityFields = { bucketId: window.bucketId, windowId: window.windowId };
    if (remaining <= policy.freezeFloorPercent)
      restrict("freeze", { code: "freeze_floor", ...identityFields });
    else if (remaining <= policy.launchFloorPercent)
      restrict("hold", { code: "launch_floor", ...identityFields });
  }
}

function matchingMeter(
  meters: QuotaConsumptionMeter[],
  limit: QuotaConsumptionLimit,
): QuotaConsumptionMeter | undefined {
  const matches = meters.filter((meter) => meter.meterId === limit.meterId);
  const meter = matches[0];
  return matches.length === 1 &&
    meter?.unit === limit.unit &&
    meter.bucketId === limit.bucketId &&
    meter.revision === limit.revision
    ? meter
    : undefined;
}

function observationExpired(observedAt: number, nowMs: number, maximumAgeSeconds: number): boolean {
  const age = nowMs - observedAt;
  return !Number.isFinite(age) || age < 0 || age > maximumAgeSeconds * 1000;
}

interface ConsumptionInput {
  meter: QuotaConsumptionMeter;
  limit: QuotaConsumptionLimit;
  nowMs: number;
  observedAt: number;
}

function readConsumption(
  input: ConsumptionInput,
): { status: "available"; consumed: number } | { status: "meter_invalid" | "meter_coverage" } {
  const { meter, limit, nowMs, observedAt } = input;
  const start =
    limit.period.kind === "trailing_hour"
      ? nowMs - 3600000
      : calendarDayStart(nowMs, limit.period.timezone);
  const coverageStart = Date.parse(meter.coverageStart);
  const coverageEnd = Date.parse(meter.coverageEnd);
  if (coverageStart >= coverageEnd || coverageEnd > nowMs) return { status: "meter_invalid" };
  if (coverageStart > start || coverageEnd < observedAt || start > observedAt)
    return { status: "meter_coverage" };
  const intervals = [...meter.intervals].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
  let previousEnd = coverageStart;
  let consumed = 0;
  for (const interval of intervals) {
    const from = Date.parse(interval.startsAt);
    const to = Date.parse(interval.endsAt);
    if (from < previousEnd || from >= to || to > coverageEnd) return { status: "meter_invalid" };
    previousEnd = to;
    // A partial interval is an upper bound; prorating would invent when usage occurred.
    if (to > start && from < coverageEnd) consumed += interval.consumed;
  }
  return Number.isFinite(consumed)
    ? { status: "available", consumed }
    : { status: "meter_invalid" };
}

function calendarDayStart(nowMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const day = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    return ["year", "month", "day"]
      .map((type) => parts.find((part) => part.type === type)?.value)
      .join("-");
  };
  const today = day(nowMs);
  let left = nowMs - 48 * 3600000;
  let right = nowMs;
  // Search UTC instants instead of subtracting 24h across local DST boundaries.
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (day(middle) < today) left = middle;
    else right = middle;
  }
  return right;
}
