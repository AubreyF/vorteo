import { isDeepStrictEqual } from "node:util";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import {
  InstallationSettingsAdmissionError,
  type InstallationSettingsAdmission,
} from "./admission.js";
import { readInstallationProviders, projectInstallationProviders } from "./providers.js";

function candidateProviders(current: MutableDaemonConfig, patch: MutableDaemonConfigPatch) {
  const providers = structuredClone(current.providers);
  for (const [id, provider] of Object.entries(patch.providers ?? {})) {
    providers[id] = { ...providers[id], ...provider };
    if (provider.paseoTools)
      providers[id].paseoTools = { ...current.providers[id]?.paseoTools, ...provider.paseoTools };
  }
  for (const id of patch.removeProviders ?? []) delete providers[id];
  return MutableDaemonConfigSchema.parse({ ...current, providers }).providers;
}
export function changesInstallationProviders(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
): boolean {
  if (patch.installationProviderPolicy) return true;
  if (!patch.providers) return false;
  const serverId = current.sharedProviderPreferences?.installation?.serverId ?? "local";
  // Removing a local connection retains its shared definition and references. The account
  // removal operation separately governs credentials; it is not a shared catalog deletion.
  const retained = Object.fromEntries(
    Object.entries(current.providers).filter(([id]) => !patch.removeProviders?.includes(id)),
  );
  return !isDeepStrictEqual(
    portableValues(serverId, retained),
    portableValues(serverId, candidateProviders(current, patch)),
  );
}

function portableValues(serverId: string, providers: MutableDaemonConfig["providers"]) {
  return readInstallationProviders(serverId, providers)
    .filter((entry) => Object.keys(entry.policy).length > 0)
    .map((entry) => ({ localId: entry.bindings[serverId], policy: entry.policy }))
    .sort((left, right) => left.localId.localeCompare(right.localId));
}

export function assertInstallationProviderProjection(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
  admission?: InstallationSettingsAdmission,
) {
  const binding = current.sharedProviderPreferences?.installation;
  if (!binding) {
    if (patch.installationProviderPolicy)
      throw new Error("Provider projection requires installation ownership");
    return;
  }
  if (!changesInstallationProviders(current, patch)) return;
  if (!admission || !admission.settings.providerDefinitions)
    throw new Error("Shared providers must be edited through the installation coordinator.");
  if (
    admission.installationId !== binding.installationId ||
    admission.serverId !== binding.serverId ||
    admission.environment !== binding.environment
  )
    throw new Error("Provider authority returned a different installation or environment");
  const definitions = admission.settings.providerDefinitions;
  const excludedIds = admission.settings.resourceExclusions[binding.serverId]?.providerIds ?? [];
  if (patch.installationProviderPolicy) {
    if (
      patch.providers ||
      patch.removeProviders?.length ||
      !isDeepStrictEqual(patch.installationProviderPolicy, { definitions, excludedIds })
    )
      throw new Error("Provider projection does not match installation authority");
    return;
  }
  assertProviderEdits(current, patch, admission);
}

function assertProviderEdits(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
  admission: InstallationSettingsAdmission,
) {
  const definitions = admission.settings.providerDefinitions ?? [];
  const excludedIds = admission.settings.resourceExclusions[admission.serverId]?.providerIds ?? [];
  const candidate = candidateProviders(current, patch);
  for (const id of Object.keys(patch.providers ?? {})) {
    const before = Object.hasOwn(current.providers, id) ? { [id]: current.providers[id] } : {};
    const selected = { [id]: candidate[id] };
    if (
      isDeepStrictEqual(
        portableValues(admission.serverId, before),
        portableValues(admission.serverId, selected),
      )
    )
      continue;
    const matches = definitions.filter(
      (definition) => definition.bindings[admission.serverId] === id,
    );
    if (matches.length !== 1)
      throw new Error("Shared providers must be edited through the installation coordinator.");
    const expected = projectInstallationProviders(
      matches,
      admission.serverId,
      selected,
      excludedIds,
    );
    const edit = patch.providers![id];
    const restoringExcluded =
      current.providers[id]?.removed === true &&
      edit.removed === false &&
      selected[id].enabled === false &&
      Object.keys(edit).every((key) => key === "removed" || key === "enabled") &&
      excludedIds.includes(matches[0].id);
    // Restore only the retained private binding. Fresh policy is projected afterward;
    // the environment exclusion continues to reject launches throughout recovery.
    if (restoringExcluded) continue;
    if (
      !isDeepStrictEqual(
        readInstallationProviders(admission.serverId, selected),
        readInstallationProviders(admission.serverId, expected),
      )
    )
      throw new Error("Shared providers must be edited through the installation coordinator.");
  }
}

export function assertInstallationProviderLaunch(
  current: MutableDaemonConfig,
  providerId: string,
  admission: InstallationSettingsAdmission,
): void {
  const definitions = admission.settings.providerDefinitions;
  if (!definitions)
    throw new InstallationSettingsAdmissionError(
      "Complete shared provider migration before starting new tasks.",
    );
  const matches = definitions.filter(
    (definition) =>
      Object.hasOwn(definition.bindings, admission.serverId) &&
      definition.bindings[admission.serverId] === providerId,
  );
  if (matches.length !== 1)
    throw new InstallationSettingsAdmissionError(
      "The provider needs a unique shared catalog binding in this environment.",
    );
  const definition = matches[0]!;
  const excluded = admission.settings.resourceExclusions[admission.serverId]?.providerIds ?? [];
  if (definition.removed || definition.policy.enabled === false || excluded.includes(definition.id))
    throw new InstallationSettingsAdmissionError(
      "The shared provider is disabled or excluded from this environment.",
    );
  const expected = projectInstallationProviders(
    [definition],
    admission.serverId,
    current.providers,
  );
  const observed = readInstallationProviders(admission.serverId, {
    [providerId]: current.providers[providerId],
  });
  const projected = readInstallationProviders(admission.serverId, {
    [providerId]: expected[providerId],
  });
  if (!isDeepStrictEqual(observed, projected))
    throw new InstallationSettingsAdmissionError(
      "Shared provider settings are still being applied. Retry after this environment synchronizes.",
    );
}

/** Local deletion is allowed only after the installation has stopped targeting that binding. */
export function assertInstallationProviderRemoval(
  providerId: string,
  admission: InstallationSettingsAdmission,
): void {
  const definitions = admission.settings.providerDefinitions;
  if (!definitions)
    throw new InstallationSettingsAdmissionError(
      "Complete shared provider migration before removing a local connection.",
    );
  const matches = definitions.filter(
    (definition) => definition.bindings[admission.serverId] === providerId,
  );
  const excluded = admission.settings.resourceExclusions[admission.serverId]?.providerIds ?? [];
  if (
    matches.length > 1 ||
    matches.some((definition) => !definition.removed && !excluded.includes(definition.id))
  )
    throw new InstallationSettingsAdmissionError(
      "Exclude this provider from this environment before deleting its local connection.",
    );
}
