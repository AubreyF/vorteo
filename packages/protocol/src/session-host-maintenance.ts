import { z } from "zod";

/**
 * Tracked operations on the durable session host's launchd job. The installation coordinator owns
 * the job: it computes every plan from its own configuration, and the owner approves each one.
 */
// COMPAT(sessionHostRestart): "session-host-restart" added in v0.11.0-beta.3.vorteo.751; older
// coordinators reject it, so clients send it only when capabilities advertise sessionHostJob.restart.
export const SessionHostOperationSchema = z.enum([
  "session-host-install",
  "session-host-remove",
  "session-host-restart",
]);
export type SessionHostOperation = z.infer<typeof SessionHostOperationSchema>;

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const AbsolutePathSchema = z.string().startsWith("/").min(2).max(4096);

/**
 * Everything one operation writes or removes. Inert: dispatch recomputes it from the current
 * configuration and refuses any difference, so an approval covers exactly what was reviewed.
 */
export const SessionHostPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: SessionHostOperationSchema,
  installationId: z.string().uuid(),
  label: z.string().regex(/^local\.vorteo\.[a-zA-Z0-9.-]+\.session-host$/),
  serviceDomain: z.string().regex(/^gui\/\d+$/),
  plistPath: AbsolutePathSchema,
  /** The plist this operation writes (install) or expects to remove; null when none exists. */
  plistSha256: DigestSchema.nullable(),
  node: AbsolutePathSchema,
  /** Resolved through the installation's current release link at every launch. */
  entrypoint: AbsolutePathSchema,
  paseoHome: AbsolutePathSchema,
  logPath: AbsolutePathSchema,
  workingDirectory: AbsolutePathSchema,
  /** The only variables the job receives besides PASEO_HOME. */
  environment: z.strictObject({
    HOME: AbsolutePathSchema,
    PATH: z.string().min(1).max(8192),
  }),
});
export type SessionHostPlan = z.infer<typeof SessionHostPlanSchema>;

/** Asks the coordinator to prepare one operation; it derives the plan itself. */
export const SessionHostRequestSchema = z.strictObject({
  id: z.string().uuid(),
  operation: SessionHostOperationSchema,
  reason: z.string().trim().min(1).max(2000),
});
export type SessionHostRequest = z.infer<typeof SessionHostRequestSchema>;

/** A daemon restart decision cannot authorize this: it must name the operation and exact plan. */
export const SessionHostDecisionSchema = z.strictObject({
  operation: SessionHostOperationSchema,
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: DigestSchema,
  decision: z.enum(["approve", "cancel"]),
});
export type SessionHostDecision = z.infer<typeof SessionHostDecisionSchema>;

export const SessionHostJobSchema = z.strictObject({
  target: z.literal("session-host"),
  operation: SessionHostOperationSchema,
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.enum(["owner", "host-agent"]),
  reason: z.string().min(1).max(2000),
  createdAt: z.string().datetime(),
  plan: SessionHostPlanSchema,
  planSha256: DigestSchema,
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  stage: z.enum(["prepared", "dispatch_pending", "applying", "verifying", "succeeded", "failed"]),
  detail: z.string(),
  approvedAt: z.string().datetime().optional(),
  /** A remove that stopped a host which no longer answered, after the workers' alive window. */
  forcedStop: z.boolean().optional(),
  /** The host that answered after an install or a restart. */
  host: z
    .strictObject({
      pid: z.number().int().positive().max(2147483647),
      release: z.string().max(200).optional(),
    })
    .optional(),
  /** The host a restart stopped, with the hosted sessions it was running at that moment. */
  previousHost: z
    .strictObject({
      pid: z.number().int().positive().max(2147483647),
      release: z.string().max(200).optional(),
      sessions: z.number().int().min(0),
    })
    .optional(),
});
export type SessionHostJob = z.infer<typeof SessionHostJobSchema>;

/** What the coordinator observes about the job. Details go to the Host token and owners only. */
export const SessionHostStatusSchema = z.strictObject({
  /** The selected release contains the session host entrypoint. */
  supported: z.boolean(),
  /** A plist or a loaded launchd job exists under the session host label. */
  installed: z.boolean(),
  detail: z
    .strictObject({
      label: z.string(),
      plist: z.enum(["absent", "matching", "different"]),
      loaded: z.boolean(),
      pid: z.number().int().positive().nullable(),
      lastExitStatus: z.number().int().nullable(),
      runs: z.number().int().min(0).nullable(),
      host: z
        .strictObject({
          pid: z.number().int().positive(),
          release: z.string().max(200).optional(),
          sessions: z.number().int().min(0),
          /** Hosted sessions by provider id. Absent from coordinators before the indicator. */
          providers: z.record(z.string().max(200), z.number().int().min(0)).optional(),
        })
        .nullable(),
      /** The release the current link selects, to compare with the host's own release. */
      installedRelease: z.string().max(200).optional(),
      /** The host found a newer installed release and exits once its sessions end. */
      upgradePending: z.boolean().optional(),
      settingEnabled: z.boolean(),
      observedAt: z.string().datetime(),
    })
    .optional(),
});
export type SessionHostStatus = z.infer<typeof SessionHostStatusSchema>;
