import { z } from "zod";

const AuditTokenSchema = z.array(z.number().int().min(0).max(0xffffffff)).length(8);

export const ProcessObservationSchema = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  bootId: z.string().uuid(),
  startIdentity: z.string().regex(/^\d+:\d+$/),
  argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.string().startsWith("/"),
});

export const BootstrapExecutorRecordSchema = z.strictObject({
  id: z.string().uuid(),
  generation: z.string().uuid(),
  pid: z.number().int().positive(),
  planSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  // Older records remain readable by the ordinary watchdog, but cannot grant
  // recovery authority over a process whose birth identity was never recorded.
  process: ProcessObservationSchema.optional(),
  auditToken: AuditTokenSchema.optional(),
});

export const AuditedProcessObservationSchema = z.strictObject({
  identity: ProcessObservationSchema,
  auditToken: AuditTokenSchema,
});
