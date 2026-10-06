import {
  ResolvedPluginSourceSchema,
  type PluginSourceResolutionInput,
} from "@getpaseo/protocol/plugin-installation";
import { OwnerAccessExpired } from "./client";

export async function resolveInstallationPluginSource(input: PluginSourceResolutionInput) {
  const response = await fetch("/api/installation/owner/settings/plugins/resolve", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 401)
    throw new OwnerAccessExpired("Unlock Installation controls in General settings to continue.");
  if (!response.ok)
    throw new Error("Unable to prepare this plugin source. Check the source and Host connection.");
  return ResolvedPluginSourceSchema.parse(await response.json());
}
