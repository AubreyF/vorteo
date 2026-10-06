import type { InstallationSettings } from "@getpaseo/protocol/installation-settings";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import { isDeepStrictEqual } from "node:util";
import {
  InstallationProviderSchema,
  InstallationProviderPolicySchema,
  type InstallationProvider,
} from "@getpaseo/protocol/installation-provider";
import { type ProviderOverrides } from "@getpaseo/protocol/provider-config";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";

const policyKeys = InstallationProviderPolicySchema.keyof().options;

/** Matching labels are never account identity. Unverified bindings remain distinct. */
export function readInstallationProviders(
  serverId: string,
  providers: ProviderOverrides,
): InstallationProvider[] {
  return Object.entries(providers)
    .filter(([, provider]) => !provider.removed)
    .map(([localId, provider]) => {
      const accountId = provider.installationAccountId;
      const policy: Record<string, unknown> = {};
      for (const key of policyKeys) if (provider[key] !== undefined) policy[key] = provider[key];
      return InstallationProviderSchema.parse({
        id: accountId
          ? `account/${accountId}`
          : `environment/${encodeURIComponent(serverId)}/${localId}`,
        providerType: resolveProviderType(localId, providers),
        ...(accountId ? { accountId } : {}),
        bindings: { [serverId]: localId },
        policy,
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Preserve the union in every candidate, and require a choice for competing portable values. */
export function mergeInstallationProviders(observations: Record<string, InstallationProvider[]>) {
  const definitions = new Map<string, InstallationProvider[]>();
  for (const [serverId, items] of Object.entries(observations)) {
    const observedBindings = new Set<string>();
    for (const item of items) {
      const validated = InstallationProviderSchema.parse(item);
      if (Object.keys(validated.bindings).length !== 1 || !validated.bindings[serverId])
        throw new Error("A provider observation cannot assign bindings in another environment");
      const localId = validated.bindings[serverId];
      const expectedId = validated.accountId
        ? `account/${validated.accountId}`
        : `environment/${encodeURIComponent(serverId)}/${localId}`;
      if (validated.id !== expectedId)
        throw new Error("Provider observation has a conflicting identity");
      if (observedBindings.has(localId)) throw new Error("Duplicate local provider binding");
      observedBindings.add(localId);
      const group = definitions.get(validated.id) ?? [];
      if (group.some((entry) => entry.bindings[serverId]))
        throw new Error("An account has multiple provider bindings in one environment");
      group.push(validated);
      definitions.set(validated.id, group);
    }
  }
  const conflicts: string[] = [];
  const candidates: Record<string, InstallationProvider[]> = {};
  for (const serverId of Object.keys(observations)) candidates[serverId] = [];
  for (const [id, choices] of definitions) {
    const first = choices[0]!;
    if (
      choices.some(
        (entry) => entry.providerType !== first.providerType || entry.accountId !== first.accountId,
      )
    )
      throw new Error("Provider identity has conflicting account or runtime types");
    if (choices.some((entry) => !isDeepStrictEqual(entry.policy, first.policy))) conflicts.push(id);
    const bindings = Object.fromEntries(choices.flatMap((entry) => Object.entries(entry.bindings)));
    for (const [serverId, catalog] of Object.entries(candidates)) {
      const chosen = choices.find((entry) => entry.bindings[serverId]) ?? first;
      catalog.push(structuredClone({ ...chosen, bindings }));
    }
  }
  for (const catalog of Object.values(candidates))
    catalog.sort((left, right) => left.id.localeCompare(right.id));
  return { candidates, conflicts: conflicts.sort(), needsReview: conflicts.length > 0 };
}

/** Returns a full local replacement, not a merge patch. Omitted portable fields are removed. */
export function projectInstallationProviders(
  definitions: readonly InstallationProvider[],
  serverId: string,
  local: ProviderOverrides,
  excludedIds: readonly string[] = [],
): ProviderOverrides {
  const projected = structuredClone(local);
  const seen = new Set<string>();
  for (const definition of definitions) {
    const localId = definition.bindings[serverId];
    if (!localId) continue;
    const provider = local[localId];
    if (seen.has(localId)) throw new Error("Several shared providers use the same local binding");
    seen.add(localId);
    const disabled = definition.removed || excludedIds.includes(definition.id);
    if (disabled && (!Object.hasOwn(local, localId) || provider?.removed)) {
      if (Object.hasOwn(projected, localId)) projected[localId]!.enabled = false;
      continue;
    }
    if (
      !Object.hasOwn(local, localId) ||
      !provider ||
      provider.removed ||
      resolveProviderType(localId, local) !== definition.providerType
    )
      throw new Error("The shared provider needs a matching local runtime binding");
    if (provider.installationAccountId !== definition.accountId)
      throw new Error("The shared provider account binding changed");
    const next = projected[localId]!;
    for (const key of policyKeys) delete next[key];
    Object.assign(next, structuredClone(definition.policy));
    if (disabled) next.enabled = false;
  }
  for (const [id, provider] of Object.entries(projected))
    if (!seen.has(id)) provider.enabled = false;
  return projected;
}

/** Persist portable replacements without replacing independent local runtime extensions. */
export function persistInstallationProviders(
  base: ProviderOverrides | undefined,
  projected: ProviderOverrides,
): ProviderOverrides {
  const result = structuredClone(base ?? {});
  for (const [id, provider] of Object.entries(projected)) {
    const retained = Object.hasOwn(result, id) ? result[id] : structuredClone(provider);
    for (const key of policyKeys) delete retained[key];
    for (const key of policyKeys)
      if (provider[key] !== undefined)
        Object.assign(retained, { [key]: structuredClone(provider[key]) });
    Object.defineProperty(result, id, {
      value: retained,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function installationProvidersSettled(
  definitions: readonly InstallationProvider[],
  serverId: string,
  providers: ProviderOverrides,
  excludedIds: readonly string[] = [],
) {
  const expected = projectInstallationProviders(definitions, serverId, providers, excludedIds);
  return isDeepStrictEqual(
    readInstallationProviders(serverId, providers),
    readInstallationProviders(serverId, expected),
  );
}

export function validateProviderAccountSetup(definition: InstallationProvider): void {
  const setup = definition.accountSetup;
  if (!setup) return;
  const providerId = `${setup.provider}-account-${setup.creationId}`;
  if (
    definition.providerType !== setup.provider ||
    Object.values(definition.bindings).some((id) => id !== providerId)
  )
    throw new Error(
      "Managed account setup must retain its provider type and deterministic binding IDs",
    );
}

/** Add only plugin-owned runtime bindings. Never import subsequent daemon policy drift. */
interface PluginProviderEnrollment {
  settings: InstallationSettings;
  serverId: string;
  plugins: readonly PluginListItem[];
  providers: ProviderOverrides;
}

function approvedPluginRegistration(plugin: PluginListItem, input: PluginProviderEnrollment) {
  const approved = input.settings.plugins?.find((entry) => entry.id === plugin.id);
  const excluded = input.settings.resourceExclusions[input.serverId]?.pluginIds ?? [];
  if (
    !approved?.enabled ||
    !plugin.enabled ||
    plugin.status !== "running" ||
    excluded.includes(plugin.id)
  )
    return false;
  return approved.source.kind === "directory"
    ? plugin.installation?.identity.kind === "directory"
    : isDeepStrictEqual(approved.source, plugin.resolvedSource);
}

export function enrollInstallationPluginProviders(
  input: PluginProviderEnrollment,
): InstallationProvider[] {
  const definitions = structuredClone(input.settings.providerDefinitions ?? []);
  for (const plugin of input.plugins) {
    if (!approvedPluginRegistration(plugin, input)) continue;
    for (const registration of plugin.providers ?? []) {
      const local = input.providers[registration.id];
      if (!local || local.removed) continue;
      if (
        local.extends ||
        local.installationAccountId ||
        resolveProviderType(registration.id, input.providers) !== registration.id
      )
        throw new Error("Plugin provider has a conflicting local account or runtime binding");
      const bound = definitions.find((entry) => entry.bindings[input.serverId] === registration.id);
      if (bound) continue;
      const id = `plugin/${encodeURIComponent(plugin.id)}/${encodeURIComponent(registration.id)}`;
      const existing = definitions.find((entry) => entry.id === id);
      if (existing) {
        if (
          existing.accountId ||
          existing.accountSetup ||
          existing.providerType !== registration.id
        )
          throw new Error("Plugin provider has a conflicting shared identity");
        existing.bindings[input.serverId] = registration.id;
      } else {
        definitions.push({
          id,
          providerType: registration.id,
          bindings: { [input.serverId]: registration.id },
          policy: { label: registration.label || registration.id, enabled: true },
        });
      }
    }
  }
  return definitions;
}
