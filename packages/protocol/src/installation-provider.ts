import { z } from "zod";
import { ProviderOverrideSchema } from "./provider-config.js";

/** Portable provider policy. Runtime arguments, account homes and credentials stay local. */
export const InstallationProviderPolicySchema = ProviderOverrideSchema.pick({
  label: true,
  description: true,
  models: true,
  additionalModels: true,
  disallowedTools: true,
  paseoTools: true,
  enabled: true,
  order: true,
}).strict();
export const InstallationProviderSchema = z.strictObject({
  id: z.string().min(1),
  providerType: z.string().min(1),
  accountId: z.string().uuid().optional(),
  accountSetup: z
    .strictObject({
      provider: z.enum(["codex", "claude"]),
      creationId: z.string().uuid(),
    })
    .optional(),
  bindings: z.record(z.string().min(1), z.string().min(1)),
  policy: InstallationProviderPolicySchema,
});
export type InstallationProvider = z.infer<typeof InstallationProviderSchema>;
export type InstallationProviderPolicy = z.infer<typeof InstallationProviderPolicySchema>;

export const InstallationProviderProjectionSchema = z.strictObject({
  definitions: z.array(InstallationProviderSchema),
  excludedIds: z.array(z.string().min(1)),
});
