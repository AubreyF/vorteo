import { z } from "zod";

/** Private journal evidence for a separately granted Host maintenance decision.
 * Public replies omit it so older clients retain their exact job schema. */
export const DelegatedMaintenanceApprovalSchema = z.strictObject({
  policyActivatedAt: z.string().datetime(),
  authoritySha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestRevision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  dispatchAfter: z.string().datetime(),
});

export const MaintenanceDelegationStatusSchema = z.strictObject({
  available: z.boolean(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  activatedAt: z.string().datetime().nullable(),
  enabled: z.boolean(),
});
export type MaintenanceDelegationStatus = z.infer<typeof MaintenanceDelegationStatusSchema>;
