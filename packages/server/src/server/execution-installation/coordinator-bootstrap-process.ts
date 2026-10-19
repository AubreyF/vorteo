import { z } from "zod";

import {
  BootstrapProcessIdentitySchema,
  BootstrapAuditedProcessSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";

export const ProcessObservationSchema = BootstrapProcessIdentitySchema;
const AuditTokenSchema = BootstrapAuditedProcessSchema.shape.auditToken;

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

export const AuditedProcessObservationSchema = BootstrapAuditedProcessSchema;
