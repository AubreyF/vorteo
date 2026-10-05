export async function openSettings(page) {
  await page
    .locator(
      '[data-testid="sidebar-settings"]:visible, [data-testid="sidebar-footer-overflow"]:visible',
    )
    .first()
    .waitFor({ state: "visible", timeout: 90_000 });
  const overflow = page.getByTestId("sidebar-footer-overflow");
  if (await overflow.isVisible()) await overflow.click();
  await page.locator('[data-testid="sidebar-settings"]:visible').click();
  await page.locator('[data-testid="settings-sidebar"]:visible').waitFor({ state: "visible" });
}
