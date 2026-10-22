import { router, type Href } from "expo-router";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  buildOpenProjectRoute,
  buildProjectSettingsRoute,
  buildProviderSettingsRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";

export type SettingsView =
  | { kind: "plugin"; serverId: string; pluginId: string; screenId: string }
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string; section: HostSectionSlug }
  | { kind: "project"; serverId: string; projectId: string }
  | { kind: "provider"; providerType: string };

export function openHostOverview(serverId: string): void {
  router.push(buildSettingsHostSectionRoute(serverId, "host"));
}

export function openProjectSettings(serverId: string, projectId: string): void {
  router.push(buildProjectSettingsRoute(serverId, projectId));
}

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
  if (view.kind === "provider") parent = buildSettingsSectionRoute("accounts");
  router.dismissTo(parent as Href);
}
