import { isDeepStrictEqual } from "node:util";
import type { InstallationPlugin } from "@getpaseo/protocol/plugin-installation";
import {
  InstallationSettingsAdmissionError,
  type InstallationSettingsAdmission,
} from "./admission.js";

export type InstallationPluginAction =
  | { kind: "configure"; source: InstallationPlugin["source"]; enabled: boolean }
  | { kind: "bind-directory"; enabled: boolean }
  | { kind: "activate" | "restore"; source: InstallationPlugin["source"] }
  | { kind: "enable" | "disable" | "remove" };

export function assertInstallationPluginAction(
  admission: InstallationSettingsAdmission,
  pluginId: string,
  action: InstallationPluginAction,
): void {
  const catalog = admission.settings.plugins;
  if (!catalog)
    throw new InstallationSettingsAdmissionError(
      "Complete shared plugin migration before changing plugins.",
    );
  const definition = catalog.find((plugin) => plugin.id === pluginId);
  const excluded =
    admission.settings.resourceExclusions[admission.serverId]?.pluginIds?.includes(pluginId) ===
    true;
  const enabled = definition !== undefined && definition.enabled && !excluded;
  let allowed: boolean;
  switch (action.kind) {
    case "bind-directory":
      allowed = mayBindDirectory(definition, {
        effectiveEnabled: enabled,
        requestedEnabled: action.enabled,
      });
      break;
    case "remove":
      allowed = definition === undefined;
      break;
    case "disable":
      allowed = !enabled;
      break;
    case "enable":
      allowed = enabled;
      break;
    case "restore":
      allowed =
        enabled &&
        admission.settings.pluginsEnabled &&
        sameManagedSource(definition?.source, action.source);
      break;
    case "activate":
      allowed =
        enabled &&
        admission.settings.pluginsEnabled &&
        isDeepStrictEqual(definition?.source, action.source);
      break;
    case "configure":
      allowed = mayConfigure(definition, excluded, action);
      break;
  }
  if (!allowed)
    throw new InstallationSettingsAdmissionError(
      "Shared plugins must be edited through the installation coordinator. Reload its current values before retrying.",
    );
}

function sameManagedSource(
  expected: InstallationPlugin["source"] | undefined,
  actual: InstallationPlugin["source"],
): boolean {
  if (!expected || expected.kind === "directory" || actual.kind === "directory") return false;
  return isDeepStrictEqual(expected.identity, actual.identity);
}

function mayConfigure(
  definition: InstallationPlugin | undefined,
  excluded: boolean,
  action: Extract<InstallationPluginAction, { kind: "configure" }>,
): boolean {
  return (
    definition !== undefined &&
    !excluded &&
    definition.enabled === action.enabled &&
    isDeepStrictEqual(definition.source, action.source)
  );
}

function mayBindDirectory(
  definition: InstallationPlugin | undefined,
  input: { effectiveEnabled: boolean; requestedEnabled: boolean },
): boolean {
  return (
    definition?.source.kind === "directory" && input.requestedEnabled === input.effectiveEnabled
  );
}
