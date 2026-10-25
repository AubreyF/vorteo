import {
  test,
  verifyProviderSettings,
  verifyNewWorkspaceModelIcon,
  verifyCompactModelIcon,
  verifyExistingAgentModelIcon,
} from "../support/helpers/plugin-provider-icons";

test("plugin provider icons follow the provider through settings and the wide and compact profile pickers", async ({
  providerIcons,
}) => {
  await verifyProviderSettings(providerIcons);
  await verifyNewWorkspaceModelIcon(providerIcons);
  await verifyCompactModelIcon(providerIcons);
  await verifyExistingAgentModelIcon(providerIcons);
});
