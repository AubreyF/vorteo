import { InstallationProviderSchema } from "./installation-provider.js";
import { InstallationSkillSchema } from "./skill-library.js";
import { InstallationPluginSchema } from "./plugin-installation.js";
import { z } from "zod";
import { TerminalProfileSchema } from "./terminal-profile.js";
import type { ProviderOverrides } from "./provider-config.js";
import { AgentSkillSelectionSchema } from "./agent-profile.js";

const ACCOUNT_REFERENCE_PREFIX = "installation-account/";

export function installationProviderReference(
  provider: string,
  providers: ProviderOverrides,
): string {
  const accountId = providers[provider]?.installationAccountId;
  return accountId ? `${ACCOUNT_REFERENCE_PREFIX}${accountId}` : provider;
}

/** Resolve only explicit bindings. Labels and provider ordering are not account identity. */
export function localInstallationProvider(
  reference: string,
  providers: ProviderOverrides,
): string | null {
  if (!reference.startsWith(ACCOUNT_REFERENCE_PREFIX)) return reference;
  const accountId = reference.slice(ACCOUNT_REFERENCE_PREFIX.length);
  const matches = Object.entries(providers).filter(
    ([, provider]) =>
      provider.installationAccountId === accountId &&
      !provider.removed &&
      provider.enabled !== false,
  );
  return matches.length === 1 ? matches[0][0] : null;
}

// Environment-local recovery data. Never include this in installation snapshots or journals.
export const InstallationResourceBindingsSchema = z.strictObject({
  terminalProfiles: z.array(TerminalProfileSchema),
  metadataProviders: z.array(
    z
      .object({
        provider: z.string(),
        model: z.string().optional(),
        thinkingOptionId: z.string().optional(),
      })
      .passthrough(),
  ),
});

const EnvironmentIdSchema = z.string().min(1);
const RevisionSchema = z.number().int().nonnegative();

export const InstallationTerminalProfileSchema = TerminalProfileSchema.pick({
  id: true,
  name: true,
  command: true,
  args: true,
  icon: true,
}).strict();

const MetadataProviderSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
});

export const InstallationSettingsSchema = z.strictObject({
  browserTools: z.strictObject({ enabled: z.boolean() }).optional(),
  providerDefinitions: z.array(InstallationProviderSchema).optional(),
  plugins: z.array(InstallationPluginSchema).optional(),
  skillLibrary: z.array(InstallationSkillSchema).optional(),
  skills: z.strictObject({ selection: AgentSkillSelectionSchema }).optional(),
  mcp: z.strictObject({ injectIntoAgents: z.boolean() }),
  appendSystemPrompt: z.string(),
  autoArchiveAfterMerge: z.boolean(),
  enableTerminalAgentHooks: z.boolean(),
  metadataGeneration: z.strictObject({ providers: z.array(MetadataProviderSchema) }),
  pluginsEnabled: z.boolean(),
  terminalProfiles: z.array(InstallationTerminalProfileSchema),
  resourceExclusions: z.record(
    EnvironmentIdSchema,
    z.strictObject({
      browserTools: z.boolean().optional(),
      providerIds: z.array(z.string().min(1)).optional(),
      pluginIds: z.array(z.string()).optional(),
      skillIdentities: z.array(z.string().min(1)).optional(),
      terminalProfileIds: z.array(z.string()),
      metadataProviderIds: z.array(z.string().min(1)),
    }),
  ),
});
export type InstallationSettings = z.infer<typeof InstallationSettingsSchema>;
export const InstallationSettingsFieldSchema = InstallationSettingsSchema.keyof();
export type InstallationSettingsField = z.infer<typeof InstallationSettingsFieldSchema>;
export const InstallationSettingsPatchSchema = InstallationSettingsSchema.partial();
export type InstallationSettingsPatch = z.infer<typeof InstallationSettingsPatchSchema>;

export const InstallationSettingsUpdateSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  settings: InstallationSettingsPatchSchema,
  confirmedSkillRemovals: z.record(EnvironmentIdSchema, z.array(z.string().min(1))).optional(),
});
export type InstallationSettingsUpdate = z.infer<typeof InstallationSettingsUpdateSchema>;

export const InstallationSettingsEnvironmentStatusSchema = z.strictObject({
  appliedRevision: RevisionSchema.nullable(),
  pendingRevision: RevisionSchema.nullable(),
  error: z
    .enum([
      "read_failed",
      "patch_failed",
      "verification_failed",
      "account_binding_unavailable",
      "skill_removal_review_required",
      "plugin_projection_failed",
      "skill_projection_failed",
    ])
    .nullable(),
});

const SnapshotBaseSchema = z.strictObject({
  version: z.literal(1),
  revision: RevisionSchema,
  sources: z.record(EnvironmentIdSchema, InstallationSettingsEnvironmentStatusSchema),
});

export const InstallationSettingsSnapshotSchema = z.union([
  SnapshotBaseSchema.extend({
    revision: z.literal(0),
    settings: z.null(),
    conflicts: z.never().optional(),
  }),
  SnapshotBaseSchema.extend({
    revision: z.number().int().positive(),
    settings: z.null(),
    conflicts: z.strictObject({
      candidates: z.record(EnvironmentIdSchema, InstallationSettingsSchema),
      fields: z.array(InstallationSettingsFieldSchema).min(1),
    }),
  }),
  SnapshotBaseSchema.extend({
    revision: z.number().int().positive(),
    settings: InstallationSettingsSchema,
    conflicts: z.never().optional(),
  }),
]);
export type InstallationSettingsSnapshot = z.infer<typeof InstallationSettingsSnapshotSchema>;
