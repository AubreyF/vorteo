import { test, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openAddHostFlow, expectAddHostMethodOptions } from "../support/helpers/settings";

test("retired pairing routes lead to authenticated direct connections", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);
  await expect(page.getByTestId("settings-section-pair-device")).toHaveCount(0);
  await page.goto("/pair-scan");
  await expect(page).toHaveURL(/\/settings\/connections$/);
  await openAddHostFlow(page);
  await expectAddHostMethodOptions(page);
  await expect(page.getByRole("button", { name: /Scan QR/ })).toHaveCount(0);
});
