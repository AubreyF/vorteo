import { z } from "zod";

/**
 * Static provider secrets (API keys and tokens) that the installation coordinator stores once
 * and delivers into every bound environment's provider `env`. Only names that read as secrets
 * are synchronized; runtime locations such as CODEX_HOME or CLAUDE_CONFIG_DIR stay local.
 */
export const PROVIDER_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,126}_(KEY|TOKEN|SECRET|PASSWORD)$/;
/** Owned by Claude subscription synchronization, never by static secret delivery. */
export const RESERVED_PROVIDER_SECRET_NAMES: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN"];

export function isProviderSecretName(name: string): boolean {
  return PROVIDER_SECRET_NAME_PATTERN.test(name) && !RESERVED_PROVIDER_SECRET_NAMES.includes(name);
}

export const ProviderSecretNameSchema = z
  .string()
  .refine(
    isProviderSecretName,
    "Use an environment variable name ending in _KEY, _TOKEN, _SECRET or _PASSWORD",
  );
const DefinitionIdSchema = z.string().min(1).max(512);

/** POST /api/installation/owner/provider-secrets/read */
export const ProviderSecretsReadRequestSchema = z.strictObject({
  definitionId: DefinitionIdSchema.optional(),
});
/** POST /api/installation/owner/provider-secrets/set. The value is never returned. */
export const ProviderSecretSetRequestSchema = z.strictObject({
  definitionId: DefinitionIdSchema,
  name: ProviderSecretNameSchema,
  value: z
    .string()
    .min(1)
    .max(16 * 1024)
    .refine(
      (value) =>
        value.trim() === value &&
        !["\0", "\r", "\n"].some((character) => value.includes(character)),
      "Remove surrounding spaces and line breaks",
    ),
});
/** POST /api/installation/owner/provider-secrets/clear */
export const ProviderSecretClearRequestSchema = z.strictObject({
  definitionId: DefinitionIdSchema,
  name: ProviderSecretNameSchema,
});

export const ProviderSecretSummarySchema = z.strictObject({
  name: z.string(),
  /** Last four characters, only for values long enough not to reveal them. */
  last4: z.string().length(4).nullable(),
  updatedAt: z.string().datetime(),
  /** "imported" values were adopted once from an environment's existing configuration. */
  source: z.enum(["owner", "imported"]),
});
export const ProviderSecretEnvironmentStatusSchema = z.strictObject({
  serverId: z.string(),
  kind: z.enum(["host", "container"]),
  /**
   * delivered: the environment applied the current secrets (or their withdrawal).
   * pending: delivery has not completed yet and has not failed.
   * failed: the last attempt failed or found a differing local value; see message.
   * excluded: the provider is removed, disabled or excluded here; secrets are withdrawn.
   */
  status: z.enum(["delivered", "pending", "failed", "excluded"]),
  message: z.string().optional(),
  /** Secret names whose differing local value was left untouched in this environment. */
  conflicts: z.array(z.string()).optional(),
});
export const ProviderSecretConflictSchema = z.strictObject({
  name: z.string(),
  /** Environments whose existing values differ. Set the value once to resolve. */
  serverIds: z.array(z.string()),
});
export const ProviderSecretsStatusSchema = z.strictObject({
  definitionId: z.string(),
  secrets: z.array(ProviderSecretSummarySchema),
  environments: z.array(ProviderSecretEnvironmentStatusSchema),
  /** Import found different values in several environments and adopted none of them. */
  conflicts: z.array(ProviderSecretConflictSchema),
  /** True when every non-excluded bound environment has the current secrets. */
  ready: z.boolean(),
  /**
   * Present for sign-in accounts whose credentials are not synchronized between environments.
   * Codex keeps a refresh grant per environment, so each listed environment needs its own
   * sign-in ("Sign in on <label>"). Signed-in state comes from that environment's provider status.
   */
  accountSignIn: z
    .strictObject({
      provider: z.literal("codex"),
      synchronized: z.literal(false),
      environments: z.array(
        z.strictObject({
          serverId: z.string(),
          kind: z.enum(["host", "container"]),
          label: z.string(),
        }),
      ),
    })
    .optional(),
});
export type ProviderSecretsStatus = z.infer<typeof ProviderSecretsStatusSchema>;
export type ProviderSecretEnvironmentStatus = z.infer<typeof ProviderSecretEnvironmentStatusSchema>;
/** Response of read, set and clear. set/clear return only the affected definition. */
export const ProviderSecretsReadResponseSchema = z.strictObject({
  definitions: z.array(ProviderSecretsStatusSchema),
});
export type ProviderSecretsReadResponse = z.infer<typeof ProviderSecretsReadResponseSchema>;
