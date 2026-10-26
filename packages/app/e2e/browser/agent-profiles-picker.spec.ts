import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { expectWorkspaceAgentConfiguration } from "../support/helpers/command-center-agent-controls";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { chooseProfile, openProfilePicker } from "../support/helpers/model-profile";

const PROFILE = {
  id: "agent_profile_e2e_ui_work",
  name: "UI work",
  icon: "🎨",
  provider: "mock",
  model: "one-minute-stream",
  modeId: "approval-test",
  notes: "Use for UI work.",
};

// The composer's model picker went with the Paseo mode in 471d7f22a: a running agent's composer
// offers only Choose profile, and the profile carries the model. Retired with it: the pinned
// profile rows inside the model picker, the composer naming the model, and the model row's
// separate create-profile action, which has no equivalent in the profile picker.
test.describe("Agent profiles in the profile picker", () => {
  // These journeys own the host's profile list, including its empty state.
  test.use({ defaultMockProfile: false });

  // Product regression, reported to Builds on 2026-10-25: with no profiles the picker lists no
  // accounts, and Manage profiles does nothing without an account (471d7f22a). Remove the fixme
  // once an empty host can reach profile settings from the picker.
  test.fixme("an empty host still exposes agent profile settings from the picker", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([], true);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-empty-",
      title: "Agent profiles empty",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await openProfilePicker(page);
      await expect(page.locator('[data-testid^="preset-row-"]')).toHaveCount(0);
      await page.getByTestId("preset-manage-profiles").click();
      await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("choosing a profile applies its model and mode to the running agent", async ({ page }) => {
    const seed = await seedAgentProfiles([PROFILE], true);
    // A live agent is one provider's process, so the profile has to name that
    // same provider or the picker will not offer it at all.
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-picker-",
      title: "Agent profiles picker",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await chooseProfile(page, { provider: "mock", profileId: PROFILE.id });
      // A running thread switches profile only after confirming in the switch sheet.
      await page.getByTestId("profile-switch-confirm").click();
      await expect(page.getByTestId("profile-switch-sheet")).toHaveCount(0, { timeout: 30_000 });
      await expectWorkspaceAgentConfiguration(workspace, {
        id: workspace.agentId,
        provider: "mock",
        model: "one-minute-stream",
        modeId: "approval-test",
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });
});
