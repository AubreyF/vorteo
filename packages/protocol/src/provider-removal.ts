import { z } from "zod";

export const ProviderRemovalPlanSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  credentials: z.enum(["managed", "shared", "external"]),
  sharedWith: z.array(z.string()),
  revision: z.string(),
});
export type ProviderRemovalPlan = z.infer<typeof ProviderRemovalPlanSchema>;

export const ProviderPreviewRemovalRequestSchema = z.object({
  type: z.literal("provider.connection.preview_remove.request"),
  requestId: z.string(),
  providerId: z.string(),
});
export const ProviderPreviewRemovalResponseSchema = z.object({
  type: z.literal("provider.connection.preview_remove.response"),
  payload: z.object({ requestId: z.string(), plan: ProviderRemovalPlanSchema }),
});
export const ProviderRemoveRequestSchema = z.object({
  type: z.literal("provider.connection.remove.request"),
  requestId: z.string(),
  providerId: z.string(),
  revision: z.string(),
});
export const ProviderRemoveResponseSchema = z.object({
  type: z.literal("provider.connection.remove.response"),
  payload: z.object({
    requestId: z.string(),
    plan: ProviderRemovalPlanSchema,
    /** Removal succeeded, but a cleanup step (such as provider sign-out) did not. */
    warning: z.string().optional(),
  }),
});
