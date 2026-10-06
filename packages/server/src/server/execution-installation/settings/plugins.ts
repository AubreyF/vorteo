import { isDeepStrictEqual } from "node:util";
import {
  InstallationPluginSchema,
  type InstallationPlugin,
} from "@getpaseo/protocol/plugin-installation";
import type {
  PluginListItem,
  PluginUpdatePreview,
  PluginUpdateProposal,
  PluginUpdateResult,
  PluginUpdateSelection,
} from "@getpaseo/protocol/messages";

/** Local paths, credentials and runtime errors do not belong in the shared catalog. */
export function readInstallationPlugins(items: readonly PluginListItem[]): InstallationPlugin[] {
  return items
    .map((item) => {
      const source =
        item.resolvedSource ??
        (item.installation?.identity.kind === "directory" ? { kind: "directory" as const } : null);
      if (!source) throw new Error("An installed plugin has no verified source recipe.");
      return InstallationPluginSchema.parse({ id: item.id, enabled: item.enabled, source });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Every candidate retains unique definitions from every environment. Differences need owner review. */
export function mergeInstallationPlugins(observations: Record<string, InstallationPlugin[]>) {
  const union = new Map<string, InstallationPlugin>();
  for (const plugins of Object.values(observations)) {
    for (const plugin of plugins) if (!union.has(plugin.id)) union.set(plugin.id, plugin);
  }
  const candidates: Record<string, InstallationPlugin[]> = {};
  const values = Object.values(observations);
  const needsReview = values.some((plugins) => !isDeepStrictEqual(plugins, values[0]));
  for (const [serverId, plugins] of Object.entries(observations)) {
    const local = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    candidates[serverId] = [...union.values()]
      .map((plugin) => structuredClone(local.get(plugin.id) ?? plugin))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
  return { candidates, needsReview };
}

export interface PluginProjectionPort {
  listPlugins(): Promise<PluginListItem[]>;
  installResolvedPluginSource(input: {
    resolved: Exclude<InstallationPlugin["source"], { kind: "directory" }>;
    id: string;
    enabled: boolean;
  }): Promise<PluginListItem>;
  previewPluginUpdates(input: {
    pluginId: string;
    target?: PluginUpdateSelection;
  }): Promise<PluginUpdatePreview[]>;
  applyPluginUpdates(proposals: PluginUpdateProposal[]): Promise<PluginUpdateResult[]>;
  enablePlugin(id: string): Promise<PluginListItem>;
  disablePlugin(id: string): Promise<PluginListItem>;
}

function matchesDefinition(item: PluginListItem, definition: InstallationPlugin): boolean {
  return definition.source.kind === "directory"
    ? item.installation?.identity.kind === "directory"
    : isDeepStrictEqual(item.resolvedSource, definition.source);
}

export function installationPluginsSettled(
  items: readonly PluginListItem[],
  definitions: readonly InstallationPlugin[],
  excludedIds: readonly string[],
): boolean {
  const available = new Map(
    definitions
      .filter((plugin) => !excludedIds.includes(plugin.id))
      .map((plugin) => [plugin.id, plugin]),
  );
  return (
    items.every((item) => available.has(item.id) || !item.enabled) &&
    [...available.values()].every((definition) => {
      const item = items.find((entry) => entry.id === definition.id);
      return (
        item !== undefined &&
        item.enabled === definition.enabled &&
        matchesDefinition(item, definition)
      );
    })
  );
}

/** Exclusion and catalog removal disable local copies, preserving private plugin settings. */
export async function projectInstallationPlugins(
  port: PluginProjectionPort,
  definitions: readonly InstallationPlugin[],
  excludedIds: readonly string[],
): Promise<void> {
  const items = await port.listPlugins();
  const desired = new Map(
    definitions
      .filter((plugin) => !excludedIds.includes(plugin.id))
      .map((plugin) => [plugin.id, plugin]),
  );
  for (const item of items) {
    if (item.enabled && !desired.get(item.id)?.enabled) {
      await port.disablePlugin(item.id);
      item.enabled = false;
    }
  }
  for (const definition of desired.values()) {
    let installed = items.find((item) => item.id === definition.id);
    if (!installed) {
      if (definition.source.kind === "directory")
        throw new Error("A shared directory plugin needs a local environment binding.");
      await port.installResolvedPluginSource({
        id: definition.id,
        resolved: definition.source,
        enabled: definition.enabled,
      });
      continue;
    }
    if (!matchesDefinition(installed, definition)) {
      await updateInstallationPlugin(port, installed, definition);
      installed = (await port.listPlugins()).find((item) => item.id === definition.id);
      if (!installed || !matchesDefinition(installed, definition))
        throw new Error("The shared plugin artifact did not converge.");
    }
    if (installed.enabled !== definition.enabled) {
      if (definition.enabled) await port.enablePlugin(definition.id);
      else await port.disablePlugin(definition.id);
    }
  }
  if (!installationPluginsSettled(await port.listPlugins(), definitions, excludedIds))
    throw new Error("The shared plugin catalog did not converge.");
}

async function updateInstallationPlugin(
  port: PluginProjectionPort,
  installed: PluginListItem,
  definition: InstallationPlugin,
): Promise<void> {
  const source = definition.source;
  if (
    source.kind === "directory" ||
    !isDeepStrictEqual(installed.installation?.identity, source.identity)
  )
    throw new Error("A shared plugin source conflicts with an existing local installation.");
  const target: PluginUpdateSelection =
    source.kind === "git"
      ? { kind: "git", ref: source.target.commit }
      : { kind: "npm", version: source.target.version };
  const selection = source.identity.registry
    ? { pluginId: definition.id }
    : { pluginId: definition.id, target };
  const preview = (await port.previewPluginUpdates(selection)).find(
    (entry) => entry.id === definition.id,
  );
  if (!preview?.proposal || !isDeepStrictEqual(preview.proposal.target, source.target))
    throw new Error("The shared plugin revision needs a fresh source review.");
  const result = await port.applyPluginUpdates([preview.proposal]);
  if (result.length !== 1 || result[0].outcome !== "updated")
    throw new Error("The shared plugin update failed.");
}
