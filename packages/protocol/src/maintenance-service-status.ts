import { z } from "zod";
import { MaintenanceServiceJobSchema } from "./maintenance-service.js";

/** Owner-facing queue receipt. Native custody records stay in protected storage. */
export const MaintenanceServiceViewSchema = MaintenanceServiceJobSchema.pick({
  id: true,
  revision: true,
  target: true,
  operation: true,
  reason: true,
  createdAt: true,
  status: true,
  detail: true,
}).extend({
  cancelable: z.boolean(),
  dispatchAfter: z.string().datetime().nullable(),
  generation: z.uuid().nullable(),
  outcome: z.enum(["candidate", "previous", "unknown"]).nullable(),
  observedAt: z.string().datetime().nullable(),
});
export type MaintenanceServiceView = z.infer<typeof MaintenanceServiceViewSchema>;

export const MaintenanceServiceQueueStatusSchema = z.strictObject({
  installationId: z.uuid(),
  available: z.boolean(),
  jobs: z.array(MaintenanceServiceViewSchema),
});
export type MaintenanceServiceQueueStatus = z.infer<typeof MaintenanceServiceQueueStatusSchema>;

export const MaintenanceServiceCancellationSchema = z.strictObject({
  id: z.uuid(),
  revision: z.uuid(),
});
