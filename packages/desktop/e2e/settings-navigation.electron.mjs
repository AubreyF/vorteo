export async function openSettings(page) {
  await page
    .locator(
      '[data-testid="sidebar-settings"]:visible, [data-testid="sidebar-footer-overflow"]:visible',
    )
    .first()
    .waitFor({ state: "visible", timeout: 90_000 });
  const settings = page.locator('[data-testid="sidebar-settings"]:visible');
  if (!(await settings.isVisible())) await page.getByTestId("sidebar-footer-overflow").click();
  await settings.click();
  await page.locator('[data-testid="settings-sidebar"]:visible').waitFor({ state: "visible" });
}
