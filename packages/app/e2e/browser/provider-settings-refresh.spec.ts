import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// The composer's model selector went with the Paseo mode in 471d7f22a. The schedule form keeps the
// same selector, so these provider settings stacks open from a new schedule's model picker.
async function openScheduleModelSelector(page: Page, projectKey: string) {
  await page.goto(buildSchedulesRoute());
  await page
    .locator('[data-testid="schedules-new"]:visible, [data-testid="schedules-empty-new"]:visible')
    .first()
    .click();
  await expect(page.getByTestId("schedule-form-sheet")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("schedule-project-trigger").click();
  await page.getByTestId(`schedule-project-option-${projectKey}`).click();
  await page.getByTestId("schedule-model-trigger").click({ timeout: 30_000 });
  await expect(page.getByTestId("selector-header-settings-mock")).toBeVisible({ timeout: 30_000 });
}

async function openProviderSettingsFromModelSelector(page: Page, projectKey: string) {
  await openScheduleModelSelector(page, projectKey);
  await page.getByTestId("selector-header-settings-mock").click();
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
}

async function expectModelBrowserVisible(page: Page) {
  await expect(page.getByTestId("selector-header-settings-mock")).toBeVisible({ timeout: 10_000 });
}

async function closeTopSheet(page: Page) {
  const closeTarget = page.getByLabel("Close", { exact: true }).last();
  if (await closeTarget.isVisible().catch(() => false)) {
    await closeTarget.click({ force: true });
    return;
  }

  const handle = page.getByRole("slider", { name: "Bottom sheet handle" }).last();
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error("Bottom sheet handle was not measurable");
  }
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 400, { steps: 8 });
  await page.mouse.up();
}

async function closeSheetByHeaderButton(page: Page, testId: string) {
  const sheet = page.getByTestId(testId);
  await sheet.getByLabel("Close", { exact: true }).click();
  await expect(sheet).not.toBeVisible({ timeout: 10_000 });
}

async function expectOverlayAbove(page: Page, frontTestId: string, backTestId: string) {
  const frontCoversBack = await page.evaluate(
    ({ frontTestId: frontId, backTestId: backId }) => {
      const front = document.querySelector(`[data-testid="${frontId}"]`);
      const back = document.querySelector(`[data-testid="${backId}"]`);
      if (!(front instanceof HTMLElement) || !(back instanceof HTMLElement)) return false;

      const frontRect = front.getBoundingClientRect();
      const backRect = back.getBoundingClientRect();
      const left = Math.max(frontRect.left, backRect.left);
      const right = Math.min(frontRect.right, backRect.right);
      const top = Math.max(frontRect.top, backRect.top);
      const bottom = Math.min(frontRect.bottom, backRect.bottom);
      if (left >= right || top >= bottom) return false;

      const topElement = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return topElement != null && front.contains(topElement);
    },
    { frontTestId, backTestId },
  );
  expect(frontCoversBack).toBe(true);
}

async function hasFocusWithin(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.contains(document.activeElement));
}

async function expectProviderSettingsVisible(page: Page) {
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Add model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diagnostic", exact: true })).toBeVisible();
}

async function exerciseProviderSettingsStack(page: Page) {
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByTestId("add-custom-model-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "add-custom-model-sheet");
  await expect(page.getByPlaceholder("e.g. openai/gpt-5")).not.toBeVisible({ timeout: 10_000 });
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Diagnostic", exact: true }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Refresh diagnostic/ }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "provider-diagnostic-sheet");
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expectProviderSettingsVisible(page);
}

test.describe("provider settings overlay stack", () => {
  test("provider model update age says just now", async ({ page }) => {
    const session = await seedWorkspace({ repoPrefix: "provider-relative-time-" });
    try {
      await page.clock.install({ time: Date.now() });
      await page.setViewportSize(MOBILE_VIEWPORT);
      await openProviderSettingsFromModelSelector(page, session.projectKey);
      await expect(page.getByText("Updated just now", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await session.cleanup();
    }
  });

  test("provider settings covers the desktop model selector without closing it", async ({
    page,
  }) => {
    const session = await seedWorkspace({ repoPrefix: "provider-modal-layer-" });

    try {
      await openScheduleModelSelector(page, session.projectKey);
      const selector = page.getByTestId("combobox-desktop-container");
      await expect(selector).toBeVisible({ timeout: 10_000 });
      const searchInput = page.getByRole("textbox", { name: /search models/i });
      await expect(searchInput).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => hasFocusWithin(selector)).toBe(true);

      await page.keyboard.press("Shift+?");
      const shortcuts = page.getByTestId("keyboard-shortcuts-dialog");
      await expect(shortcuts).toBeVisible({ timeout: 10_000 });
      await expect(page.getByPlaceholder("Search shortcuts")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(shortcuts).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();

      await page.keyboard.press("ControlOrMeta+K");
      const commandCenter = page.getByTestId("command-center-panel");
      await expect(commandCenter).toBeVisible({ timeout: 10_000 });
      await expect(commandCenter.getByTestId("command-center-input")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(commandCenter).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();

      await page.keyboard.press("ControlOrMeta+K");
      await expect(commandCenter).toBeVisible({ timeout: 10_000 });
      await commandCenter.getByTestId("command-center-input").fill("add project");
      await commandCenter.getByText("Add project", { exact: true }).click();
      const addProject = page.getByTestId("add-project-flow");
      await expect(addProject).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(addProject).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();

      const settingsButton = page.getByTestId("selector-header-settings-mock");
      await settingsButton.click();

      const settings = page.getByTestId("provider-settings-sheet");
      await expect(settings).toBeVisible({ timeout: 10_000 });
      await expectOverlayAbove(page, "provider-settings-sheet", "combobox-desktop-container");

      await page.keyboard.press("Escape");
      await expect(settings).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();
      // Reported to Builds on 2026-10-25: in the schedule form, closing provider settings returns
      // focus to the picker's Back button rather than the settings button that opened it. Focus
      // still stays inside the selector.
      await expect.poll(() => hasFocusWithin(selector)).toBe(true);
    } finally {
      await session.cleanup();
    }
  });

  test("provider settings and children close back through the model browser to configuration", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.setViewportSize(MOBILE_VIEWPORT);
    const session = await seedWorkspace({ repoPrefix: "provider-sheet-stack-" });

    try {
      await openProviderSettingsFromModelSelector(page, session.projectKey);
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelBrowserVisible(page);
      await page.getByTestId("selector-header-settings-mock").click();
      await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelBrowserVisible(page);
      await closeTopSheet(page);
      await expect(page.getByTestId("selector-header-settings-mock")).not.toBeVisible({
        timeout: 10_000,
      });
      // Closing the model sheet returns to the schedule form it opened from.
      await expect(page.getByTestId("schedule-form-sheet")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
