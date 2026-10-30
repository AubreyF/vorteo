import { router, type Href } from "expo-router";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  buildOpenProjectRoute,
  buildProjectSettingsRoute,
  buildProviderSettingsRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
  type SettingsSectionSlug,
} from "@/utils/host-routes";

/**
 * An item that a deep link opens in place inside its section: a provider
 * expanded in Accounts & profiles, or an environment's tab in Environments.
 */
export type SettingsFocus =
  | { kind: "provider"; providerType: string }
  | { kind: "environment"; serverId: string };

export type SettingsView =
  | { kind: "plugin"; serverId: string; pluginId: string; screenId: string }
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug; focus?: SettingsFocus }
  | { kind: "project"; serverId: string; projectId: string };

export function openHostOverview(serverId: string): void {
  router.push(buildSettingsHostSectionRoute(serverId, "host"));
}

export function openProjectSettings(serverId: string, projectId: string): void {
  router.push(buildProjectSettingsRoute(serverId, projectId));
}

/** Opens Accounts & profiles with the provider expanded in place. */
export function openProviderSettings(providerType: string): void {
  router.push(buildProviderSettingsRoute(providerType));
}

export function returnFromSettings(view: SettingsView): void {
  if (view.kind === "root") {
    if (!navigateToLastWorkspace()) {
      router.replace(buildOpenProjectRoute());
    }
    return;
  }

  let parent: Href = buildSettingsRoute();
  if (view.kind === "plugin") parent = buildSettingsSectionRoute("plugins");
  if (view.kind === "project") parent = buildSettingsSectionRoute("projects");
  router.dismissTo(parent as Href);
}
