import { test } from "../support/fixtures";
import { withButtonShowcase } from "../support/helpers/plugin-buttons";

test("plugin header and composer buttons share actions, menus, content, and updates", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await withButtonShowcase(page, async (buttons) => {
    await buttons.verifyObservationLifetime();
    await buttons.openWideMenusAndPopovers();
    await buttons.runAndUpdateActions();
    await buttons.hideAndUnloadOpenButtons();
  });
});

// Product regression, reported to Builds on 2026-10-25: since 195e1c044 phones have no plugin
// header toolbar, so header buttons are unreachable there. Remove the fixme once they return.
test.fixme("plugin header buttons open sheets on phones", async ({ page }) => {
  test.setTimeout(180_000);
  await withButtonShowcase(page, async (buttons) => {
    await buttons.openCompactSheets();
  });
});
