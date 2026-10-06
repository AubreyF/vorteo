import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { expect, test } from "../support/fixtures";
import {
  closeModelPicker,
  openModelPicker,
  seedAgentProfiles,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";
import { seedWorkspace } from "../support/helpers/seed-client";

test.setTimeout(120_000);

const PRIMARY = {
  id: "codex-primary-test",
  label: "Codex Primary",
  models: [
    {
      id: "primary-model",
      label: "Primary model",
      description: "Primary test model",
    },
  ],
};

const SECONDARY = {
  id: "codex-secondary-test",
  label: "Codex Secondary",
  models: [
    {
      id: "secondary-model",
      label: "Secondary model",
      description: "Secondary test model",
    },
  ],
};

test("account usage stays in Vorton presets while Paseo retains its model picker", async ({
  page,
}, testInfo) => {
  const primaryProvider = await seedModelProvider(PRIMARY);
  const secondaryProvider = await seedModelProvider(SECONDARY);
  const profiles = await seedAgentProfiles([
    {
      id: "agent_profile_primary_usage",
      name: PRIMARY.label,
      provider: PRIMARY.id,
    },
    {
      id: "agent_profile_secondary_usage",
      name: SECONDARY.label,
      provider: SECONDARY.id,
    },
  ]);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "usage-workflows" });
  const previous = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
  await client.patchDaemonConfig({
    expectedProviderPreferencesRevision: previous.revision,
    sharedProviderPreferences: {
      ...previous,
      providers: {
        ...previous.providers,
        claude: {
          defaults: {},
          preferredModels: [],
          preferredThinkingOptions: [],
          workflows: [{ id: "usage", name: "Usage", provider: "claude" }],
          defaultWorkflowId: "usage",
        },
      },
    },
  });
  const workspace = await seedWorkspace({
    repoPrefix: "provider-usage-selector-",
  });
  const usageFixture = await installProviderUsageFixture(page, [
    {
      fetchedAt: new Date().toISOString(),
      providers: [
        {
          providerId: PRIMARY.id,
          displayName: PRIMARY.label,
          status: "available",
          planLabel: "pro",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              remainingPct: 84,
              resetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
            },
          ],
        },
        {
          providerId: SECONDARY.id,
          displayName: SECONDARY.label,
          status: "available",
          planLabel: "pro",
          windows: [{ id: "weekly", label: "Weekly", remainingPct: 17 }],
        },
      ],
    },
  ]);

  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await expectComposerVisible(page);
    await openModelPicker(page);
    const primaryProfile = page.getByTestId("model-profile-row-agent_profile_primary_usage");
    const secondaryProfile = page.getByTestId("model-profile-row-agent_profile_secondary_usage");
    await expect(primaryProfile.getByText(PRIMARY.label, { exact: true })).toHaveCount(1);
    await expect(secondaryProfile.getByText(SECONDARY.label, { exact: true })).toHaveCount(1);
    await expect(page.getByTestId(`model-provider-${PRIMARY.id}`)).not.toContainText("84%");
    await expect(page.getByTestId(`model-provider-${SECONDARY.id}`)).not.toContainText("17%");
    expect(usageFixture.requestCount()).toBe(0);
    await closeModelPicker(page);

    await page.getByTestId("agent-preset-selector").filter({ visible: true }).first().click();
    await usageFixture.waitForRequestCount(1);
    const primaryPreset = page.getByTestId(`preset-account-${PRIMARY.id}`);
    const secondaryPreset = page.getByTestId(`preset-account-${SECONDARY.id}`);
    await expect(primaryPreset).toContainText("84% left");
    await expect(primaryPreset).toContainText(/resets in \d+h/);
    await expect(secondaryPreset).toContainText("17% left");
    await expect(primaryPreset.getByRole("progressbar", { name: "Usage remaining" })).toBeVisible();
    await expect(
      secondaryPreset.getByRole("progressbar", { name: "Usage remaining" }),
    ).toBeVisible();

    await testInfo.attach("provider-usage-model-selector", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await workspace.cleanup();
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
    await client.patchDaemonConfig({
      sharedProviderPreferences: previous,
      expectedProviderPreferencesRevision: current.revision,
    });
    await client.close();
    await profiles.restore();
    await secondaryProvider.restore();
    await primaryProvider.restore();
  }
});
