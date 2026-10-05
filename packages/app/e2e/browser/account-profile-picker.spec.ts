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
};
const ultra = { ...medium, id: "account-ultra", name: "Astra Ultra", modeId: "approval-test" };

test("profile cards group accounts, search on demand, and collapse choices on mobile", async ({
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
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByText("Choose profile", { exact: true })).toBeVisible();
    await expect(page.getByTestId("preset-environment-card")).toBeVisible();
    await expect(page.getByTestId("preset-account-mock")).toHaveCount(1);
    await expect(page.getByTestId("shared-model-trigger")).toHaveCount(0);
    await expect(page.getByTestId("shared-thinking-trigger")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search accounts" })).toHaveCount(0);
    await page.getByTestId("preset-row-shared-workflow/mock/account-ultra").click();
    await expect(page.getByTestId("profile-customization-details")).toContainText("Approval Test");
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
    const chosenProfile = page.getByTestId("preset-row-shared-workflow/mock/account-ultra");
    await expect(chosenProfile).not.toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
    const check = await chosenProfile.locator("svg").first().boundingBox();
    const label = await chosenProfile.getByText("Astra Ultra", { exact: true }).boundingBox();
    expect(check!.x + check!.width).toBeLessThan(label!.x);

    await page.getByTestId("preset-search-toggle").click();
    await page.getByRole("textbox", { name: "Search accounts" }).fill("Ultra");
    await expect(page.getByTestId("preset-account-mock")).toBeVisible();
    await expect(page.getByTestId("preset-row-shared-workflow/mock/account-ultra")).toBeVisible();
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
    await page.getByTestId("preset-search-toggle").click();
    await page.getByRole("textbox", { name: "Search accounts" }).fill("Ultra");
    await expect(page.getByTestId("preset-manage-profiles")).toHaveCount(0);
    await page.getByTestId("preset-search-toggle").click();
    await expect(page.getByRole("textbox", { name: "Search accounts" })).toHaveCount(0);
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
