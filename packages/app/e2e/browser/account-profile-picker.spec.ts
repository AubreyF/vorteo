import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { setVortonMode } from "../support/helpers/app";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const medium = {
  id: "account-medium",
  name: "Astra Medium",
  provider: "mock",
  model: "ten-second-stream",
  modeId: "load-test",
  instructions: "Review the project instructions before making changes.\n".repeat(40),
};
const ultra = { ...medium, id: "account-ultra", name: "Astra Ultra", modeId: "approval-test" };

test("profile cards use border selection, a separate activation action, and compact sections", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = await seedAgentProfiles([medium, ultra], true);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "account-picker-",
    title: "Account picker",
    model: "e2e-fast-stream",
    initialPrompt: "Remember the profile picker acceptance task.",
  });
  try {
    await workspace.client.waitForAgentUpsert(
      workspace.agentId,
      (agent) => agent.status === "idle",
      15_000,
    );
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await setVortonMode(page, true);
    await expect(page.getByTestId("agent-preset-selector")).toContainText("Choose profile");
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByText("Choose profile", { exact: true })).toBeVisible();
    await expect(page.getByTestId("preset-environment-card")).toBeVisible();
    await expect(page.getByTestId("preset-account-mock")).toHaveCount(1);
    const environmentTile = page
      .locator('[data-testid^="preset-environment-"][role="button"]')
      .first();
    const environmentBounds = await environmentTile.boundingBox();
    const accountBounds = await page.getByTestId("preset-account-mock").boundingBox();
    expect(environmentBounds!.height).toBe(accountBounds!.height);
    const accountRadius = await page
      .getByTestId("preset-account-mock")
      .evaluate((element) => getComputedStyle(element).borderRadius);
    await expect(environmentTile).toHaveCSS("border-radius", accountRadius);
    await expect(page.getByTestId("shared-model-trigger")).toHaveCount(0);
    await expect(page.getByTestId("shared-thinking-trigger")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search accounts" })).toHaveCount(0);
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    await page.getByTestId("preset-row-shared-workflow/mock/account-ultra").click();
    await expect(page.getByTestId("profile-customization-details")).toContainText("Approval Test");
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
    const chosenProfile = page.getByTestId("preset-row-shared-workflow/mock/account-ultra");
    await expect(chosenProfile).not.toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
    await expect(chosenProfile.locator("svg")).toHaveCount(0);
    await expect(page.getByTestId("preset-use-profile")).toHaveText("Activate Profile");
    const card = await page.getByTestId("preset-profile-card").boundingBox();
    const action = await page.getByTestId("preset-use-profile").boundingBox();
    expect(action!.y).toBeGreaterThanOrEqual(card!.y + card!.height);
    const profileScroll = page.getByTestId("preset-profile-scroll");
    await profileScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => profileScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect((await page.getByTestId("preset-use-profile").boundingBox())!.y).toBe(action!.y);
    await profileScroll.evaluate((element) => {
      element.scrollTop = 0;
    });

    await expect(page.getByTestId("preset-search-toggle")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("profile-cards-desktop.png") });
    await page.getByTestId("preset-manage-profiles").click();
    await expect(page.getByTestId("provider-settings-sheet")).toBeVisible();
    await expect(page.getByTestId("agent-profile-row-account-medium")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-manage-profiles")).toHaveCount(0);
    await expect(page.getByTestId("preset-section-environment")).toBeVisible();
    await expect(page.getByTestId("preset-section-account")).toBeVisible();
    await expect(page.getByTestId("preset-choices-mock")).toBeVisible();
    await page.getByTestId("preset-section-account").click();
    await expect(page.getByTestId("preset-choices-mock")).toHaveCount(0);
    await expect(page.getByTestId("preset-account-mock")).toBeVisible();
    await page.getByTestId("preset-account-mock").click();
    await expect(page.getByTestId("preset-choices-mock")).toBeVisible();
    await page.getByTestId("preset-row-shared-workflow/mock/account-ultra").click();
    await page.getByTestId("preset-section-environment").click();
    await expect(page.getByTestId("preset-choices-mock")).toHaveCount(0);
    await page.getByTestId("preset-section-profile").click();
    await expect(page.getByTestId("profile-customization-details")).toContainText("Approval Test");
    await expect(page.getByTestId("preset-search-toggle")).toHaveCount(0);
    await waitForSettledPosition(page.getByTestId("account-preset-menu"));
    await expect(page.getByTestId("preset-use-profile")).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath("profile-cards-mobile.png") });
    await page.getByTestId("preset-use-profile").click();
    await expect(page.getByTestId("preset-handoff-modal")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await setVortonMode(page, false);
    await expect(page.getByTestId("agent-preset-selector")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});

test("active profile hides the action until a different profile is selected", async ({ page }) => {
  const seed = await seedAgentProfiles([medium, ultra], true);
  const workspace = await seedWorkspace({ repoPrefix: "active-profile-picker-" });
  try {
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      profileId: "shared-workflow/mock/account-medium",
    });
    await openAgentRoute(page, { ...workspace, agentId: agent.id });
    await expectComposerVisible(page);
    await setVortonMode(page, true);
    await expect(page.getByTestId("agent-preset-selector")).toContainText("Astra Medium");
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-row-shared-workflow/mock/account-medium")).toBeVisible();
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    await page.getByTestId("preset-row-shared-workflow/mock/account-ultra").click();
    await expect(page.getByTestId("preset-use-profile")).toHaveText("Switch to Profile");
    await page.getByTestId("preset-row-shared-workflow/mock/account-medium").click();
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});
