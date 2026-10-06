import { z } from "zod";
import { AgentProfileSchema, type AgentProfile } from "./agent-profile.js";
import { localInstallationProvider } from "./installation-settings.js";

/** Shared launch choices are keyed by configured provider ancestry, never account labels. */
export const ProviderDefaultsSchema = AgentProfileSchema.omit({
  id: true,
  name: true,
  provider: true,
  isDefault: true,
  excludedEnvironments: true,
}).strip();
export type ProviderDefaults = z.infer<typeof ProviderDefaultsSchema>;

export const ProviderPreferencesSchema = z.object({
  defaults: ProviderDefaultsSchema,
  preferredModels: z.array(z.string()),
  preferredThinkingOptions: z.array(z.string()),
  workflows: z.array(AgentProfileSchema),
  defaultWorkflowId: z.string().nullable(),
});
export type ProviderPreferences = z.infer<typeof ProviderPreferencesSchema>;

export const SharedProviderPreferencesSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  defaultProvider: z.string().optional(),
  installation: z
    .object({
      installationId: z.string().uuid(),
      environment: z.enum(["host", "container"]),
      serverId: z.string().min(1),
      revision: z.number().int().positive(),
    })
    .optional(),
  workflowAliases: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /** Imported worker account references, keyed by provider type and canonical workflow ID. */
  workflowWorkerBindings: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  providers: z.record(z.string(), ProviderPreferencesSchema),
  legacyProfiles: z.record(
    z.string(),
    z.object({
      provider: z.string(),
      providerType: z.string(),
      workflowId: z.string(),
      /** Local worker account/alias binding; valid only for the canonical worker target. */
      workerProfileId: z.string().optional(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
    }),
  ),
});
export type SharedProviderPreferences = z.infer<typeof SharedProviderPreferencesSchema>;

export interface ProviderAncestry {
  extends?: string;
  installationAccountId?: string;
  enabled?: boolean;
  removed?: boolean;
}

export function sharedWorkflowProfileId(provider: string, workflowId: string): string {
  return `shared-workflow/${encodeURIComponent(provider)}/${encodeURIComponent(workflowId)}`;
}

export function isSharedWorkflowProfile(id: string): boolean {
  return id.startsWith("shared-workflow/");
}

/** Account rows are views of shared workflows; they are never saved as account copies. */
export function materializeSharedProfiles(input: {
  preferences: SharedProviderPreferences;
  providers: Readonly<Record<string, ProviderAncestry>>;
  providerIds: readonly string[];
}): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const provider of input.providerIds) {
    const providerType = resolveProviderType(provider, input.providers);
    const group = input.preferences.providers[providerType];
    if (!group) continue;
    for (const workflow of group.workflows) {
      const workerReference = legacyWorkerReference(
        workflow.workerProfileId ?? group.defaults.workerProfileId,
        input.preferences.workflowWorkerBindings?.[providerType]?.[workflow.id],
        input.preferences,
        input.providers,
      );
      profiles.push({
        ...group.defaults,
        ...workflow,
        provider,
        id: sharedWorkflowProfileId(provider, workflow.id),
        isDefault:
          workflow.id === group.defaultWorkflowId &&
          (!input.preferences.defaultProvider || input.preferences.defaultProvider === provider),
        featureValues: { ...group.defaults.featureValues, ...workflow.featureValues },
        ...(workerReference
          ? { workerProfileId: localWorkerReference(workerReference, provider, input) }
          : {}),
      });
    }
  }
  return profiles;
}

export function materializeLegacyProfiles(
  preferences: SharedProviderPreferences,
  providers: Readonly<Record<string, ProviderAncestry>> = {},
): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const [id, binding] of Object.entries(preferences.legacyProfiles)) {
    const group = preferences.providers[binding.providerType];
    const workflow = group?.workflows.find((entry) => entry.id === binding.workflowId);
    if (!workflow) continue;
    const canonicalWorker = workflow.workerProfileId ?? group.defaults.workerProfileId;
    const workerReference = legacyWorkerReference(
      canonicalWorker,
      binding.workerProfileId,
      preferences,
      providers,
    );
    profiles.push({
      ...group.defaults,
      ...workflow,
      id,
      provider: binding.provider,
      ...(workerReference
        ? {
            workerProfileId: localWorkerReference(workerReference, binding.provider, {
              preferences,
              providers,
              providerIds: [
                ...new Set([
                  binding.provider,
                  ...Object.keys(providers),
                  ...Object.keys(preferences.providers),
                ]),
              ],
            }),
          }
        : {}),
      ...(binding.model !== undefined ? { model: binding.model ?? undefined } : {}),
      ...(binding.thinkingOptionId !== undefined
        ? { thinkingOptionId: binding.thinkingOptionId ?? undefined }
        : {}),
      ...(group.defaults.featureValues || workflow.featureValues
        ? { featureValues: { ...group.defaults.featureValues, ...workflow.featureValues } }
        : {}),
    });
  }
  return profiles;
}

function legacyWorkerReference(
  canonical: string | undefined,
  local: string | undefined,
  preferences: SharedProviderPreferences,
  providers: Readonly<Record<string, ProviderAncestry>>,
): string | undefined {
  if (!canonical || !local) return canonical;
  const canonicalParts = canonical.split("/");
  if (canonicalParts.length !== 3 || canonicalParts[0] !== "shared-workflow") return canonical;
  const type = decodeURIComponent(canonicalParts[1]);
  const workflowId = decodeURIComponent(canonicalParts[2]);
  const binding = preferences.legacyProfiles[local];
  if (binding && binding.providerType === type && binding.workflowId === workflowId) return local;
  const localParts = local.split("/");
  if (localParts.length !== 3 || localParts[0] !== "shared-workflow") return canonical;
  const account = decodeURIComponent(localParts[1]);
  if (account.startsWith("installation-account/")) {
    return decodeURIComponent(localParts[2]) === workflowId ? local : canonical;
  }
  const localType = legacyWorkerProviderType(account, preferences, providers);
  const originalId = decodeURIComponent(localParts[2]);
  const localId = preferences.workflowAliases?.[localType]?.[originalId] ?? originalId;
  if (localType !== type || localId !== workflowId) return canonical;
  return sharedWorkflowProfileId(account, workflowId);
}

function legacyWorkerProviderType(
  account: string,
  preferences: SharedProviderPreferences,
  providers: Readonly<Record<string, ProviderAncestry>>,
): string {
  if (providers[account]) return resolveProviderType(account, providers);
  const binding = Object.values(preferences.legacyProfiles).find(
    (entry) => entry.provider === account,
  );
  return binding?.providerType ?? account;
}

export class ProviderAncestryError extends Error {
  constructor(readonly provider: string) {
    super(`Provider inheritance contains a cycle at ${provider}.`);
    this.name = "ProviderAncestryError";
  }
}

export function resolveProviderType(
  provider: string,
  providers: Readonly<Record<string, ProviderAncestry>>,
): string {
  const visited = new Set<string>();
  let current = provider;
  while (providers[current]?.extends) {
    if (visited.has(current)) throw new ProviderAncestryError(current);
    visited.add(current);
    const parent = providers[current].extends;
    if (!parent || parent === "acp") return current;
    current = parent;
  }
  return current;
}

function localWorkerReference(
  reference: string,
  provider: string,
  input: Parameters<typeof materializeSharedProfiles>[0],
): string {
  if (!isSharedWorkflowProfile(reference)) return reference;
  const segments = reference.split("/");
  if (segments.length !== 3) return reference;
  const type = decodeURIComponent(segments[1]);
  const workflowId = decodeURIComponent(segments[2]);
  const localAccount = localInstallationProvider(type, input.providers);
  if (localAccount === null) return reference;
  if (localAccount !== type) return sharedWorkflowProfileId(localAccount, workflowId);
  if (resolveProviderType(type, input.providers) !== type) return reference;
  const sameType = resolveProviderType(provider, input.providers) === type;
  const account = sameType
    ? provider
    : input.providerIds.find((id) => resolveProviderType(id, input.providers) === type);
  return account ? sharedWorkflowProfileId(account, workflowId) : reference;
}
