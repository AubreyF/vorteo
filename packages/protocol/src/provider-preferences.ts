import { z } from "zod";
import { AgentProfileSchema, type AgentProfile } from "./agent-profile.js";

/** Shared launch choices are keyed by configured provider ancestry, never account labels. */
export const ProviderPreferencesSchema = z.object({
  defaults: AgentProfileSchema.omit({ id: true, name: true, provider: true, isDefault: true }),
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
  workflowAliases: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  providers: z.record(z.string(), ProviderPreferencesSchema),
  legacyProfiles: z.record(
    z.string(),
    z.object({
      provider: z.string(),
      providerType: z.string(),
      workflowId: z.string(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
    }),
  ),
});
export type SharedProviderPreferences = z.infer<typeof SharedProviderPreferencesSchema>;

export interface ProviderAncestry {
  extends?: string;
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
      const workerReference = workflow.workerProfileId ?? group.defaults.workerProfileId;
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
    const workerReference = workflow.workerProfileId ?? group.defaults.workerProfileId;
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
  const sameType = resolveProviderType(provider, input.providers) === type;
  const account = sameType
    ? provider
    : input.providerIds.find((id) => resolveProviderType(id, input.providers) === type);
  return account ? sharedWorkflowProfileId(account, workflowId) : reference;
}
