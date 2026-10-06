import { Redirect } from "expo-router";
import { buildSettingsSectionRoute } from "@/utils/host-routes";

export default function SettingsHostProjectsRoute() {
  return <Redirect href={buildSettingsSectionRoute("projects")} />;
}
