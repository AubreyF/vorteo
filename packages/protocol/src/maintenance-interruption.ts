import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const HeldRestartSchema = z.object({
  requestId: z.string().uuid(),
  generation: z.string().uuid(),
  workerPid: z.number().int().positive(),
  workerInstanceId: z.string().uuid(),
  terminateAt: z.number().int().positive(),
});
export type HeldRestart = z.infer<typeof HeldRestartSchema>;

export const DaemonMaintenanceProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative().optional(),
  bootId: z.string().min(1).max(128),
  startIdentity: z.string().min(1).max(128),
  executable: z.string().startsWith("/"),
  argumentsSha256: digest,
});

/** Immutable effect reservation in the existing lifecycle journal. A retained
 * reservation permits observation, never another restart invocation. */
export const StandingInterruptionSchema = z.strictObject({
  held: HeldRestartSchema,
  approvedRevision: z.string().uuid(),
  grantRevision: z.string().uuid(),
  holdGeneration: z.string().uuid(),
  decisionSha256: digest,
  planSha256: digest,
  reservedAt: z.string().datetime(),
  finishDeadlineAt: z.string().datetime(),
  native: z.strictObject({
    identitySha256: digest,
    serverId: z.string().min(1).max(256),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    selectedRelease: z.string().startsWith("/"),
    observedAt: z.string().datetime(),
    supervisor: DaemonMaintenanceProcessSchema,
    worker: DaemonMaintenanceProcessSchema,
  }),
  candidate: z
    .strictObject({
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      artifactSha256: digest,
      release: z.string().startsWith("/"),
    })
    .nullable(),
});
export type StandingInterruption = z.infer<typeof StandingInterruptionSchema>;
