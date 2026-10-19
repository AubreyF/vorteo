import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FactoryPanel, FactoryScreen } from "./client/panel.js";

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: "overview",
    title: "Factory",
    Component: FactoryScreen,
  });
  const removePanel = client.addWorkspacePanel({
    id: "overview",
    title: "Factory",
    icon: "Factory",
    context: "workspace",
    Component: FactoryPanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "open-factory",
    title: "Open Factory",
    icon: "Factory",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("overview");
    },
  });
  return () => {
    removeCommand();
    removePanel();
    removeScreen();
  };
}
