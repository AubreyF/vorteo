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
  removed: z.boolean().optional(),
  accountId: z.string().uuid().optional(),
  accountSetup: z
    .strictObject({
      provider: z.enum(["codex", "claude"]),
      creationId: z.string().uuid(),
      /** Claude only. Absent means a setup-token account; "full" is web sign-in whose
       * grant the Host keeps and refreshes. Older daemons reject the field, so it is set
       * only after every environment advertises claudeFullSignIn. */
      signIn: z.literal("full").optional(),
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
