import { z } from "zod";

const QuantitySchema = z.number().finite().nonnegative();
const InstantSchema = z.string().datetime({ offset: true });

export const QuotaAccountSchema = z.object({
  issuer: z.string().min(1),
  accountId: z.string().min(1),
});
export type QuotaAccount = z.infer<typeof QuotaAccountSchema>;

export const QuotaWindowSchema = z.object({
  bucketId: z.string().min(1),
  windowId: z.string().min(1),
  durationMinutes: z.number().finite().positive(),
  usedPercent: z.number().finite().min(0).max(100),
  resetsAt: InstantSchema.nullable(),
  // A reset estimate alone does not establish whether a window refills in full.
  semantics: z.enum(["fixed_reset", "rolling", "unknown"]),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const QuotaConsumptionUnitSchema = z.enum(["weekly_quota_points", "tokens", "credits"]);
export type QuotaConsumptionUnit = z.infer<typeof QuotaConsumptionUnitSchema>;

export const QuotaConsumptionMeterSchema = z.object({
  meterId: z.string().min(1),
  bucketId: z.string().min(1),
  unit: QuotaConsumptionUnitSchema,
  quality: z.enum(["authoritative", "upper_bound"]),
  revision: z.string().min(1),
  // Coverage certifies complete sparse reporting. Omitted intervals inside it
  // are zero consumption, never missing observations. Revision identifies the
  // meter definition, including the allowance denominator, not a sample number.
  coverageStart: InstantSchema,
  coverageEnd: InstantSchema,
  intervals: z.array(
    z.object({
      startsAt: InstantSchema,
      endsAt: InstantSchema,
      consumed: QuantitySchema,
    }),
  ),
});
export type QuotaConsumptionMeter = z.infer<typeof QuotaConsumptionMeterSchema>;

export const EstimatedHourlyUsageSchema = z.object({
  bucketId: z.string().min(1),
  windowId: z.string().min(1),
  authenticationGeneration: z.string().min(1),
  coverageStart: InstantSchema,
  observedAt: InstantSchema,
  // Account-wide occupancy deltas, never attributable billing or a strict meter.
  // Null means insufficient continuous history, including resets and read gaps.
  consumedPoints: QuantitySchema.nullable(),
});

export const QuotaObservationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    account: QuotaAccountSchema,
    observedAt: InstantSchema,
    windows: z.array(QuotaWindowSchema).min(1),
    consumptionMeters: z.array(QuotaConsumptionMeterSchema),
    estimatedHourlyUsage: EstimatedHourlyUsageSchema.optional(),
    // A trusted adapter emits these only when provider accounting proves all
    // charges for the captured execution are reflected, including owned work.
    // A later balance read, token total, or process exit is not this evidence.
    settledExecutions: z
      .array(
        z.object({
          executionId: z.string().min(1),
          authenticationGeneration: z.string().min(1),
          accountedAt: InstantSchema,
        }),
      )
      .optional(),
    // Diagnostic activity is deliberately separate from enforceable meters.
    tokenActivity: z
      .object({
        lifetimeTokens: QuantitySchema.nullable(),
        dailyBuckets: z.array(z.object({ date: z.string(), tokens: QuantitySchema })).nullable(),
      })
      .optional(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum([
      "unsupported",
      "authentication_required",
      "account_changed",
      "identity_unavailable",
      "windows_unavailable",
      "invalid_observation",
      "read_failed",
    ]),
  }),
]);
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;

export const QuotaConsumptionLimitSchema = z.object({
  meterId: z.string().min(1),
  bucketId: z.string().min(1),
  revision: z.string().min(1),
  unit: QuotaConsumptionUnitSchema,
  period: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("calendar_day"), timezone: z.string().min(1) }),
    z.object({ kind: z.literal("trailing_hour") }),
  ]),
  throttleAt: QuantitySchema,
  holdAt: QuantitySchema,
  freezeAt: QuantitySchema,
});
export type QuotaConsumptionLimit = z.infer<typeof QuotaConsumptionLimitSchema>;

export const QuotaGovernorPolicySchema = z.object({
  version: z.literal(1),
  account: QuotaAccountSchema,
  // Bound by trusted account/model discovery when the policy is attached.
  // Missing applicability cannot be represented as an empty requirement.
  requiredWindows: z
    .array(
      z.object({
        bucketId: z.string().min(1),
        windowId: z.string().min(1),
        durationMinutes: z.number().finite().positive(),
      }),
    )
    .min(1),
  launchFloorPercent: z.number().finite().min(0).max(100),
  freezeFloorPercent: z.number().finite().min(0).max(100),
  maxObservationAgeSeconds: z.number().finite().positive().max(120),
  consumptionLimits: z.array(QuotaConsumptionLimitSchema),
  estimatedHourly: z
    .object({
      bucketId: z.string().min(1),
      windowId: z.string().min(1),
      maxConsumedPoints: z.number().finite().positive().max(100),
    })
    .optional(),
  // An owner-managed, account-bound exception for prepaid execution. Weekly
  // occupancy and its estimate do not measure prepaid spending. Other limits stay enforced.
  prepaidAuthorization: z
    .object({
      bucketId: z.string().min(1),
      windowId: z.string().min(1),
      startsAt: InstantSchema,
      expiresAt: InstantSchema,
    })
    .optional(),
  recovery: z.literal("automatic_after_reconciliation"),
});
export type QuotaGovernorPolicy = z.infer<typeof QuotaGovernorPolicySchema>;

/** Cross-field validation stays outside wire schemas used by generated validators. */
export function parseQuotaGovernorPolicy(input: unknown): QuotaGovernorPolicy {
  const policy = QuotaGovernorPolicySchema.parse(input);
  // Zero reserves intentionally run until exhaustion; positive reserves retain hysteresis.
  if (policy.freezeFloorPercent >= policy.launchFloorPercent && policy.freezeFloorPercent !== 0) {
    throw new Error("Freeze floor must be below the launch floor.");
  }
  if (
    policy.estimatedHourly &&
    !policy.requiredWindows.some(
      (window) =>
        window.bucketId === policy.estimatedHourly!.bucketId &&
        window.windowId === policy.estimatedHourly!.windowId &&
        window.durationMinutes === 10080,
    )
  ) {
    throw new Error("Estimated hourly policy requires its weekly allowance window.");
  }
  const prepaid = policy.prepaidAuthorization;
  if (prepaid) {
    const duration = Date.parse(prepaid.expiresAt) - Date.parse(prepaid.startsAt);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400_000)
      throw new Error("Prepaid authorization must have a positive duration of at most 24 hours.");
    const weeklyWindow = policy.requiredWindows.some(
      (window) =>
        window.bucketId === prepaid.bucketId &&
        window.windowId === prepaid.windowId &&
        window.durationMinutes === 10080,
    );
    if (!weeklyWindow)
      throw new Error("Prepaid authorization requires its exact weekly allowance window.");
  }
  const periods = new Set<string>();
  for (const limit of policy.consumptionLimits) {
    if (limit.throttleAt > limit.holdAt || limit.holdAt > limit.freezeAt) {
      throw new Error("Consumption thresholds must satisfy throttle <= hold <= freeze.");
    }
    if (limit.period.kind === "calendar_day") {
      // Reject invalid zones when saving, not after a task has started spending.
      new Intl.DateTimeFormat("en", { timeZone: limit.period.timezone }).format(0);
    }
    const key = JSON.stringify([limit.meterId, limit.period.kind]);
    if (periods.has(key)) throw new Error("A meter cannot repeat the same consumption period.");
    periods.add(key);
  }
  return policy;
}
