import { expect, test } from "../support/fixtures";
import { openAddProjectFlow, addProjectFlow } from "../support/helpers/add-project-flow";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  expectPinnedUsage,
  openCompactSidebar,
} from "../support/helpers/usage-sidebar-item";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectSidebarToolbarRow,
  expectFooterSeparator,
  footerScreenshot,
  expectFooterSettingsKeys,
  leaveSettings,
  openSidebarNavSettings,
  seedSidebarFooterPreferences,
  setFooterItemVisible,
} from "../support/helpers/sidebar-nav-settings";

test("footer rows leave the toolbar icon line unchanged", async ({ page }) => {
  test.setTimeout(120_000);
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await seedSidebarFooterPreferences(page, [
    { key: "add-project", visible: false },
    { key: "usage", visible: true },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAppShell(page);
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  await expectSidebarToolbarRow(page);
  await expectFooterSeparator(page, true);
  await footerScreenshot(page, "footer-desktop-with-rows");
  await openAddProjectFlow(page);
  await page.keyboard.press("Escape");
  await expect(addProjectFlow(page)).toBeHidden();
  await openSidebarNavSettings(page);
  await expectFooterSettingsKeys(page, ["usage"]);
  await setFooterItemVisible(page, "usage", false);
  await leaveSettings(page);
  await expectFooterSeparator(page, false);
  await expectSidebarToolbarRow(page);
  await footerScreenshot(page, "footer-desktop-without-rows");
  await page.setViewportSize({ width: 390, height: 844 });
  await openCompactSidebar(page);
  await expectFooterSeparator(page, false);
  await expectSidebarToolbarRow(page);
  await footerScreenshot(page, "footer-compact-without-rows");
  await openAddProjectFlow(page);
  await page.keyboard.press("Escape");
  await expect(addProjectFlow(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSidebarNavSettings(page);
  await setFooterItemVisible(page, "usage", true);
  await leaveSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCompactSidebar(page);
  await expectFooterSeparator(page, true);
  await expectSidebarToolbarRow(page);
  await footerScreenshot(page, "footer-compact-with-rows");
});

// Retired 2026-10-23: owners can no longer reorder or hide sidebar items or footer rows from
// Settings. 9332fbd2d removed the Sidebar preferences, and 471d7f22a stopped rendering the pane.
// The tests for reordering and hiding top-level items, turning every item off, and reordering and
// hiding footer rows covered that removed feature.
