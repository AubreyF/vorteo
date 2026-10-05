import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoAppShell, setVortonMode } from "../support/helpers/app";

test("Vorton toolbar keeps navigation and sidebar actions above the projects", async ({ page }) => {
  const seeded = await seedWorkspace({ repoPrefix: "toolbar-layout-" });
  try {
    await page.goto("/open-project");
    await setVortonMode(page, true);
    const toolbar = page.getByTestId("sidebar-toolbar");
    const more = toolbar.getByTestId("sidebar-footer-overflow");
    await expect(more).toBeVisible();
    const navigationButtons = toolbar.getByTestId(
      /^sidebar-(search|sessions|schedules|settings|footer-overflow)$/,
    );
    await expect(navigationButtons).toHaveCount(5);
    await expect(navigationButtons).toHaveText(["", "", "", "", ""]);
    const names = await navigationButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    );
    expect(names).toEqual(["Search", "History", "Schedules", "Settings", "More sidebar actions"]);
    await toolbar.getByTestId("sidebar-search").click();
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await toolbar.getByTestId("sidebar-settings").click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await page.getByTestId("settings-back-to-workspace").click();

    await expect(page.getByText("Workspaces", { exact: true })).toHaveCount(0);
    await toolbar.getByTestId("sidebar-sessions").click();
    await expect(page).toHaveURL(/\/sessions$/);
    await toolbar.getByTestId("sidebar-schedules").click();
    await expect(page).toHaveURL(/\/schedules$/);

    await more.click();
    await page.screenshot({ path: test.info().outputPath("toolbar-menu.png") });
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    await expect(page.getByTestId("sidebar-global-new-workspace")).toBeVisible();
    await expect(page.getByTestId("sidebar-display-preferences-action")).toBeVisible();
    await page.getByTestId("sidebar-help-action").click();
    await expect(page.getByTestId("sidebar-help-menu")).toBeVisible();
    await page.keyboard.press("Escape");

    await more.click();
    await page.getByTestId("sidebar-display-preferences-action").click();
    await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible();
    await page.getByTestId("sidebar-display-grouping").click();
    await expect(page.getByTestId("sidebar-grouping-status")).toBeVisible();
    await page.getByTestId("sidebar-grouping-project").click();

    await more.click();
    await page.getByTestId("sidebar-global-new-workspace").click();
    await expect(page).toHaveURL(/\/new(?:\?|$)/);
    await setVortonMode(page, false);
    await expect(page.getByTestId("sidebar-footer-overflow")).toHaveCount(0);
    await expect(page.getByText("Workspaces", { exact: true })).toBeVisible();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});

test("compact toolbar keeps every navigation icon and the menu reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
    );
  });
  await gotoAppShell(page);
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const toolbar = page.getByTestId("sidebar-toolbar");
  await expect(toolbar.getByTestId("sidebar-sessions")).toBeInViewport();
  await expect(toolbar.getByTestId("sidebar-schedules")).toBeInViewport();
  await expect(toolbar.getByTestId("sidebar-search")).toBeInViewport();
  await expect(toolbar.getByTestId("sidebar-settings")).toBeInViewport();
  await toolbar.getByTestId("sidebar-footer-overflow").click();
  await page.screenshot({ path: test.info().outputPath("compact-toolbar-menu.png") });
  await page.getByTestId("sidebar-display-preferences-action").click();
  await expect(page.getByTestId("sidebar-display-grouping")).toBeVisible();
  await page.getByTestId("sidebar-display-grouping").click();
  await page.getByTestId("sidebar-grouping-project").click();
  await toolbar.getByTestId("sidebar-sessions").click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(toolbar).not.toBeVisible();
});

test("Search tooltip follows the configured command palette shortcut", async ({ page }) => {
  await page.addInitScript(() => {
    const preferencesKey = "@paseo:create-agent-preferences";
    localStorage.setItem(
      preferencesKey,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(preferencesKey) ?? "{}"),
        vortonMode: true,
      }),
    );
    localStorage.setItem(
      "@paseo:keyboard-shortcut-overrides",
      JSON.stringify({
        "command-center-toggle-cmd-k-mac": "Alt+J",
        "command-center-toggle-ctrl-k-non-mac": "Alt+J",
      }),
    );
  });
  await gotoAppShell(page);
  if (process.platform === "darwin") {
    await page.keyboard.press("Alt+Space");
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await page.getByTestId("sidebar-search").hover();
  const tooltip = page.getByTestId("sidebar-search-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Search");
  await expect(tooltip).toContainText("J");
  await page.keyboard.press("Alt+j");
  await expect(page.getByTestId("command-center-panel")).toBeVisible();
});
