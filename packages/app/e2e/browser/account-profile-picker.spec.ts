import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { expect, test } from "../support/fixtures";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { setVortonMode } from "../support/helpers/app";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const medium = {
  id: "account-medium",
  name: "Astra Medium",
  provider: "mock",
  model: "e2e-fast-stream",
  modeId: "load-test",
};
const ultra = { ...medium, id: "account-ultra", name: "Astra Ultra", modeId: "approval-test" };

test("account picker groups profiles, slides into mobile details, and opens account profile settings", async ({
  page,
}) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "account-picker" });
  const previous = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
  await client.patchDaemonConfig({
    expectedProviderPreferencesRevision: previous.revision,
    sharedProviderPreferences: {
      ...previous,
      providers: {
        ...previous.providers,
        mock: {
          defaults: {},
          preferredModels: [medium.model],
          preferredThinkingOptions: [],
          workflows: [medium, ultra],
          defaultWorkflowId: medium.id,
        },
      },
    },
  });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "account-picker-",
    title: "Account picker",
  });
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await setVortonMode(page, true);
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-account-mock")).toHaveCount(1);
    await expect(page.getByTestId("preset-row-shared-workflow/mock/account-medium")).toBeVisible();
    await page.getByTestId("preset-row-shared-workflow/mock/account-ultra").click();
    await expect(page.getByTestId("profile-customization-details")).toContainText("Approval Test");
    await page.getByRole("textbox", { name: "Search accounts" }).fill("Ultra");
    await expect(page.getByTestId("preset-account-mock")).toBeVisible();
    await expect(page.getByTestId("preset-row-shared-workflow/mock/account-medium")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("account-picker-desktop.png") });
    await page.getByTestId("preset-manage-profiles").click();
    await expect(page.getByTestId("provider-settings-sheet")).toBeVisible();
    await expect(page.getByTestId("agent-profile-row-account-medium")).toBeVisible();
    await expect(page.getByTestId("agent-profile-row-account-ultra")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("account-profiles-modal.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-account-mock")).toHaveCount(1);
    await expect(page.getByTestId("preset-choices-mock")).toHaveCount(0);
    await waitForSettledPosition(page.getByTestId("preset-account-mock"));
    const accountRow = await page.getByTestId("preset-account-mock").boundingBox();
    expect(accountRow!.height).toBeLessThanOrEqual(96);
    const menuBeforeSwipe = await page.getByTestId("account-preset-menu").boundingBox();
    const touch = await page.context().newCDPSession(page);
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const startY = accountRow!.y + accountRow!.height / 2;
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 180, y: startY }],
    });
    for (let step = 1; step <= 12; step++) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 180, y: startY - step * 18 }],
      });
      await page.waitForTimeout(20);
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect
      .poll(async () => {
        const menu = await page.getByTestId("account-preset-menu").boundingBox();
        return menuBeforeSwipe!.y - menu!.y;
      })
      .toBeGreaterThan(100);
    await waitForSettledPosition(page.getByTestId("preset-account-mock"));
    const expandedAccount = await page.getByTestId("preset-account-mock").boundingBox();
    const search = await page.getByRole("textbox", { name: "Search accounts" }).boundingBox();
    expect(expandedAccount!.y).toBeGreaterThanOrEqual(search!.y + search!.height);
    await touch.detach();
    await page.getByRole("textbox", { name: "Search accounts" }).fill("Ultra");
    await page.getByTestId("preset-account-mock").click();
    await expect(page.getByTestId("preset-accounts-back")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search accounts" })).toBeHidden();
    await expect(page.getByTestId("preset-account-mock")).toHaveCount(0);
    await expect(
      page.getByTestId("preset-row-shared-workflow/mock/account-ultra"),
    ).toBeInViewport();
    await waitForSettledPosition(page.getByTestId("preset-choices-mock"));
    const menu = await page.getByTestId("account-preset-menu").boundingBox();
    const details = await page.getByTestId("preset-connection-details").boundingBox();
    expect(details!.width).toBeCloseTo(menu!.width, 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath("account-picker-mobile-details.png") });
    await page.getByTestId("preset-accounts-back").click();
    await expect(page.getByTestId("preset-choices-mock")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search accounts" })).toHaveValue("Ultra");
    await expect(page.getByTestId("preset-account-mock")).toBeInViewport();
    await waitForSettledPosition(page.getByTestId("preset-account-mock"));
    await page.screenshot({ path: test.info().outputPath("account-picker-mobile-list.png") });
    await page.getByTestId("preset-account-mock").click();
    await expect(page.getByTestId("preset-row-shared-workflow/mock/account-medium")).toBeVisible();
    await page.getByTestId("preset-manage-profiles").click();
    await expect(page.getByTestId("agent-profile-row-account-medium")).toBeVisible();
  } finally {
    await workspace.cleanup();
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
    await client.patchDaemonConfig({
      sharedProviderPreferences: previous,
      expectedProviderPreferencesRevision: current.revision,
    });
    await client.close();
  }
});
