import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentProfile,
  MutableDaemonConfig,
  ProviderPreferences,
  SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import {
  sharedWorkflowProfileId,
  resolveProviderType,
} from "@getpaseo/protocol/provider-preferences";
import { installationProviderReference } from "@getpaseo/protocol/installation-settings";

export interface ProfileImport {
  serverId: string;
  preferences: SharedProviderPreferences;
  providers?: MutableDaemonConfig["providers"];
}

export interface ImportedProfiles {
  providers: Record<string, ProviderPreferences>;
  workflowIds: Record<string, Record<string, Record<string, string>>>;
}

interface WorkerBindingEnvironment {
  preferences: SharedProviderPreferences;
  providers: MutableDaemonConfig["providers"];
}

/** Carry verified worker account choices to environments where the workflow is newly imported. */
export function shareWorkerAccountBindings(environments: WorkerBindingEnvironment[]): void {
  const portable: Record<string, Record<string, string>> = {};
  for (const environment of environments) {
    for (const candidate of workerAccountBindingCandidates(environment)) {
      const binding = portableWorkerAccountBinding(candidate);
      if (!binding) continue;
      const { type, id } = candidate;
      portable[type] ??= {};
      const previous = portable[type][id];
      if (previous && previous !== binding)
        throw new Error(`Worker account bindings conflict for workflow ${id}`);
      portable[type][id] = binding;
    }
  }
  for (const environment of environments) {
    const { preferences } = environment;
    preferences.workflowWorkerBindings ??= {};
    for (const [type, bindings] of Object.entries(portable)) {
      const local = (preferences.workflowWorkerBindings[type] ??= {});
      for (const [id, binding] of Object.entries(bindings)) {
        const reference = local[id];
        const explicit =
          reference && portableWorkerAccountBinding({ ...environment, type, id, reference });
        if (!explicit) local[id] = binding;
      }
    }
  }
}

interface WorkerAccountBindingInput extends WorkerBindingEnvironment {
  type: string;
  id: string;
  reference: string;
  parentProvider?: string;
}

function workerAccountBindingCandidates(
  environment: WorkerBindingEnvironment,
): WorkerAccountBindingInput[] {
  const candidates: WorkerAccountBindingInput[] = [];
  const { preferences } = environment;
  for (const [type, bindings] of Object.entries(preferences.workflowWorkerBindings ?? {})) {
    for (const [id, reference] of Object.entries(bindings))
      candidates.push({ ...environment, type, id, reference });
  }
  for (const binding of Object.values(preferences.legacyProfiles)) {
    if (!binding.workerProfileId) continue;
    candidates.push({
      ...environment,
      type: binding.providerType,
      id: binding.workflowId,
      reference: binding.workerProfileId,
      parentProvider: binding.provider,
    });
  }
  return candidates;
}

function portableWorkerAccountBinding({
  preferences,
  providers,
  type,
  id,
  reference,
  parentProvider,
}: WorkerAccountBindingInput): string | null {
  const group = preferences.providers[type];
  const workflow = group?.workflows.find((entry) => entry.id === id);
  if (!workflow) return null;
  const canonical = workflow.workerProfileId ?? group.defaults.workerProfileId;
  const target = canonical?.split("/");
  if (target?.length !== 3 || target[0] !== "shared-workflow") return null;
  const legacy = preferences.legacyProfiles[reference];
  const parts = reference.split("/");
  if (!legacy && (parts.length !== 3 || parts[0] !== "shared-workflow")) return null;
  const provider = legacy?.provider ?? decodeURIComponent(parts[1]);
  if (provider === parentProvider) return null;
  const account = installationProviderReference(provider, providers);
  if (account === provider) return null;
  const workerType = resolveProviderType(provider, providers);
  const workerId =
    legacy?.workflowId ??
    resolveWorkflowAlias(preferences, workerType, decodeURIComponent(parts[2]));
  if (workerType !== decodeURIComponent(target[1]) || workerId !== decodeURIComponent(target[2]))
    return null;
  return sharedWorkflowProfileId(account, workerId);
}

/** Import each environment without collapsing different behavior or copying account bindings. */
export function importEnvironmentProfiles(sources: ProfileImport[]): ImportedProfiles {
  sources = sources.map((source) => ({
    ...source,
    preferences: normalizeLegacyProfileValues(source.preferences),
  }));
  const result: ImportedProfiles = { providers: {}, workflowIds: {} };
  for (const source of sources) {
    const mappings: Record<string, Record<string, string>> = {};
    result.workflowIds[source.serverId] = mappings;
    for (const [type, group] of Object.entries(source.preferences.providers)) {
      const mapping: Record<string, string> = {};
      mappings[type] = mapping;
      const target = result.providers[type] ?? {
        ...structuredClone(group),
        defaults: portableDefaults(group.defaults),
        workflows: [],
        defaultWorkflowId: null,
      };
      result.providers[type] = target;
      target.preferredModels = [...new Set([...target.preferredModels, ...group.preferredModels])];
      target.preferredThinkingOptions = [
        ...new Set([...target.preferredThinkingOptions, ...group.preferredThinkingOptions]),
      ];
      for (const workflow of group.workflows) {
        // Flatten inherited fields when importing distinct environment defaults.
        const effective = effectiveProfile(workflow, group.defaults);
        const { id: _id, ...behavior } = effective;
        const matching = effective.workerProfileId
          ? undefined
          : target.workflows.find((candidate) => {
              const { id: _candidateId, ...candidateBehavior } = effectiveProfile(
                candidate,
                target.defaults,
              );
              return isDeepStrictEqual(candidateBehavior, behavior);
            });
        const digest = createHash("sha256")
          .update(JSON.stringify([source.serverId, type, workflow.id]))
          .digest("hex");
        const id = matching?.id ?? `installation-workflow-${digest}`;
        mapping[workflow.id] = id;
        if (!matching) {
          const imported = inheritProviderDefaults({ ...effective, id }, target.defaults);
          target.workflows.push(imported);
        }
        if (target.defaultWorkflowId === null && group.defaultWorkflowId === workflow.id)
          target.defaultWorkflowId = id;
      }
    }
  }
  remapImportedWorkers(sources, result);
  return result;
}

export function projectEnvironmentProfiles(input: {
  config: MutableDaemonConfig;
  providers: Record<string, ProviderPreferences>;
  workflowIds: Record<string, Record<string, string>>;
}): SharedProviderPreferences {
  const saved = input.config.sharedProviderPreferences;
  if (!saved) throw new Error("Update the daemon before sharing profiles");
  const preferences = normalizeLegacyProfileValues(saved);
  const legacyProfiles = structuredClone(preferences.legacyProfiles);
  for (const binding of Object.values(legacyProfiles)) {
    const mapped = input.workflowIds[binding.providerType]?.[binding.workflowId];
    if (mapped) binding.workflowId = mapped;
  }
  const workflowAliases = structuredClone(preferences.workflowAliases ?? {});
  const workflowWorkerBindings = captureWorkflowWorkerBindings(preferences, input.workflowIds);
  for (const [type, mapping] of Object.entries(input.workflowIds)) {
    const aliases = workflowAliases[type] ?? {};
    for (const oldId of Object.keys(aliases)) {
      const target = resolveWorkflowAlias(preferences, type, oldId);
      aliases[oldId] = mapping[target] ?? target;
    }
    for (const [oldId, target] of Object.entries(mapping)) {
      if (oldId !== target) aliases[oldId] = target;
    }
    if (Object.keys(aliases).length) workflowAliases[type] = aliases;
  }
  const hasAliases = Object.keys(workflowAliases).length > 0;
  return {
    ...preferences,
    providers: structuredClone(input.providers),
    legacyProfiles,
    ...(hasAliases ? { workflowAliases } : {}),
    ...(Object.keys(workflowWorkerBindings).length ? { workflowWorkerBindings } : {}),
  };
}

function captureWorkflowWorkerBindings(
  preferences: SharedProviderPreferences,
  workflowIds: Record<string, Record<string, string>>,
): NonNullable<SharedProviderPreferences["workflowWorkerBindings"]> {
  const bindings = structuredClone(preferences.workflowWorkerBindings ?? {});
  for (const [type, group] of Object.entries(preferences.providers)) {
    for (const workflow of group.workflows) {
      const reference = workflow.workerProfileId ?? group.defaults.workerProfileId;
      if (!reference) continue;
      const target = workflowIds[type]?.[workflow.id] ?? workflow.id;
      bindings[type] ??= {};
      bindings[type][target] ??= reference;
    }
  }
  return bindings;
}

/** Detached records are complete launch definitions, not overrides of provider defaults. */
export function prepareEnvironmentProfiles(
  config: MutableDaemonConfig,
  serverId: string,
): SharedProviderPreferences {
  const saved = config.sharedProviderPreferences;
  if (!saved) throw new Error("Update the daemon before importing installation profiles");
  const preferences = normalizeLegacyProfileValues(saved);
  const preparedTypes = new Set<string>();
  for (const profile of config.agentProfiles ?? []) {
    const binding = preferences.legacyProfiles[profile.id];
    if (binding) {
      if (
        saved.legacyProfiles[profile.id]?.workerProfileId === undefined &&
        profile.workerProfileId
      )
        binding.workerProfileId = profile.workerProfileId;
      continue;
    }
    const type = resolveProviderType(profile.provider, config.providers);
    const group = preferences.providers[type] ?? {
      defaults: {},
      preferredModels: [],
      preferredThinkingOptions: [],
      workflows: [],
      defaultWorkflowId: null,
    };
    preferences.providers[type] = group;
    if (!preparedTypes.has(type)) {
      group.workflows = group.workflows.map((workflow) =>
        effectiveProfile(workflow, group.defaults),
      );
      group.defaults = portableDefaults(group.defaults);
      preparedTypes.add(type);
    }
    const digest = createHash("sha256")
      .update(JSON.stringify([serverId, profile.provider, profile.id]))
      .digest("hex");
    const id = `detached-profile-${digest}`;
    group.workflows.push(effectiveProfile({ ...structuredClone(profile), id, provider: type }, {}));
    preferences.legacyProfiles[profile.id] = {
      provider: profile.provider,
      providerType: type,
      workflowId: id,
      ...(profile.workerProfileId ? { workerProfileId: profile.workerProfileId } : {}),
    };
    if (profile.model && !group.preferredModels.includes(profile.model))
      group.preferredModels.push(profile.model);
    if (
      profile.thinkingOptionId &&
      !group.preferredThinkingOptions.includes(profile.thinkingOptionId)
    )
      group.preferredThinkingOptions.push(profile.thinkingOptionId);
    if (profile.isDefault) {
      group.defaultWorkflowId = id;
      preferences.defaultProvider = profile.provider;
    }
  }
  return preferences;
}

export function canonicalizeWorkerReferences(
  preferences: SharedProviderPreferences,
  providers: MutableDaemonConfig["providers"],
): void {
  const workflowIds: Record<string, Record<string, string>> = {};
  for (const [type, group] of Object.entries(preferences.providers)) {
    workflowIds[type] = {};
    for (const workflow of group.workflows) workflowIds[type][workflow.id] = workflow.id;
  }
  const source = { serverId: "canonical", preferences, providers };
  for (const group of Object.values(preferences.providers)) {
    if (group.defaults.workerProfileId)
      group.defaults.workerProfileId = portableWorkerReference(
        group.defaults.workerProfileId,
        source,
        workflowIds,
      );
    for (const workflow of group.workflows) {
      if (workflow.workerProfileId)
        workflow.workerProfileId = portableWorkerReference(
          workflow.workerProfileId,
          source,
          workflowIds,
        );
    }
  }
}

function portableDefaults(
  defaults: ProviderPreferences["defaults"],
): ProviderPreferences["defaults"] {
  const portable: ProviderPreferences["defaults"] = {};
  if (defaults.model !== undefined) portable.model = defaults.model;
  if (defaults.thinkingOptionId !== undefined)
    portable.thinkingOptionId = defaults.thinkingOptionId;
  if (defaults.modeId !== undefined) portable.modeId = defaults.modeId;
  return portable;
}

function effectiveProfile(
  profile: AgentProfile,
  defaults: ProviderPreferences["defaults"],
): AgentProfile {
  return {
    ...defaults,
    ...profile,
    model: profile.model ?? defaults.model ?? "",
    thinkingOptionId: profile.thinkingOptionId ?? defaults.thinkingOptionId ?? "",
    modeId: profile.modeId ?? defaults.modeId ?? "",
    featureValues: { ...defaults.featureValues, ...profile.featureValues },
  };
}

function resolveWorkflowAlias(
  preferences: SharedProviderPreferences,
  type: string,
  id: string,
): string {
  const aliases = preferences.workflowAliases?.[type] ?? {};
  const visited = new Set<string>();
  while (aliases[id] !== undefined) {
    if (visited.has(id)) throw new Error(`Workflow alias cycle at ${id}`);
    visited.add(id);
    id = aliases[id];
  }
  return id;
}

/** Convert saved legacy value overrides into distinct canonical definitions once. */
export function normalizeLegacyProfileValues(
  saved: SharedProviderPreferences,
): SharedProviderPreferences {
  const preferences = structuredClone(saved);
  for (const [legacyId, binding] of Object.entries(preferences.legacyProfiles)) {
    const group = preferences.providers[binding.providerType];
    const workflow = group?.workflows.find((entry) => entry.id === binding.workflowId);
    if (!workflow) throw new Error(`Legacy profile ${legacyId} has no workflow`);
    const effective = { ...group.defaults, ...workflow };
    if (binding.workerProfileId === undefined && effective.workerProfileId)
      binding.workerProfileId = effective.workerProfileId;
    const model = binding.model === null ? undefined : (binding.model ?? effective.model);
    const thinkingOptionId =
      binding.thinkingOptionId === null
        ? undefined
        : (binding.thinkingOptionId ?? effective.thinkingOptionId);
    if (model !== effective.model || thinkingOptionId !== effective.thinkingOptionId) {
      const digest = createHash("sha256")
        .update(JSON.stringify([legacyId, model, thinkingOptionId]))
        .digest("hex");
      const id = `legacy-profile-${digest}`;
      if (!group.workflows.some((entry) => entry.id === id))
        group.workflows.push({
          ...workflow,
          id,
          model: model ?? "",
          thinkingOptionId: thinkingOptionId ?? "",
        });
      binding.workflowId = id;
    }
    delete binding.model;
    delete binding.thinkingOptionId;
  }
  return preferences;
}

function remapImportedWorkers(sources: ProfileImport[], result: ImportedProfiles): void {
  for (const source of sources) {
    for (const [type, group] of Object.entries(source.preferences.providers)) {
      const defaultsReference = group.defaults.workerProfileId;
      for (const workflow of group.workflows) {
        const reference = workflow.workerProfileId ?? defaultsReference;
        const id = result.workflowIds[source.serverId][type][workflow.id];
        const imported = result.providers[type].workflows.find((entry) => entry.id === id);
        if (!imported || !reference) continue;
        imported.workerProfileId = portableWorkerReference(
          reference,
          source,
          result.workflowIds[source.serverId],
        );
      }
    }
  }
}

function portableWorkerReference(
  reference: string,
  source: ProfileImport,
  workflowIds: Record<string, Record<string, string>>,
): string {
  const parts = reference.split("/");
  const binding = source.preferences.legacyProfiles[reference];
  let type: string;
  let workflowId: string;
  if (binding) {
    type = binding.providerType;
    workflowId = binding.workflowId;
  } else if (parts.length === 3 && parts[0] === "shared-workflow") {
    type = resolveProviderType(decodeURIComponent(parts[1]), source.providers ?? {});
    workflowId = resolveWorkflowAlias(source.preferences, type, decodeURIComponent(parts[2]));
  } else {
    throw new Error(`Cannot share worker reference ${reference} without a portable binding`);
  }
  const mapped = workflowIds[type]?.[workflowId];
  if (!mapped) throw new Error(`Shared worker ${reference} does not exist`);
  return sharedWorkflowProfileId(type, mapped);
}

function inheritProviderDefaults(
  profile: AgentProfile,
  defaults: ProviderPreferences["defaults"],
): AgentProfile {
  const imported = { ...profile };
  for (const key of [
    "model",
    "thinkingOptionId",
    "modeId",
    "instructions",
    "workerProfileId",
    "maxWorkers",
    "featureValues",
    "quotaReservePolicy",
  ] as const) {
    if (isDeepStrictEqual(imported[key], defaults[key])) delete imported[key];
  }
  return imported;
}
