import { expect, test } from "../support/fixtures";

test("retired focus mode cannot hide workspace controls or split panes", async ({ page }, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("focus-removal-seeded")) return;
    sessionStorage.setItem(
      "vorteo:demo:panel-state",
      JSON.stringify({
        version: 19,
        state: {
          desktop: { agentListOpen: true, focusModeEnabled: true },
          sidebarWidth: 320,
          sidebarCompact: false,
          supportingCardExpanded: { journal: false },
          inlineCardExpanded: { tasks: false },
        },
      }),
    );
    sessionStorage.setItem("focus-removal-seeded", "true");
  });
  await page.goto("/?demo=1");
  const row = page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const cards = page.getByTestId("workspace-supporting-cards");
  const toolbar = page.getByTestId("workspace-shared-toolbar");
  await expect(cards).toBeVisible();
  await expect(toolbar).toBeVisible();
  const menu = toolbar.getByTestId("workspace-split-pane-menu");
  await menu.click();
  await page.getByTestId("workspace-split-pane-right").click();
  const panes = page.locator('[data-testid^="workspace-pane-"]').filter({ visible: true });
  const paneCount = await panes.count();
  expect(paneCount).toBeGreaterThanOrEqual(2);
  // A new split opens an empty tab; select the agent before checking its cards.
  await page.getByRole("button", { name: "Review accessible navigation", exact: true }).click();
  await expect(cards).toBeVisible();
  const before = await cards.boundingBox();
  for (const shortcut of ["Meta+Shift+F", "Control+Shift+F"]) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(shortcut);
    await expect(row).toBeVisible();
    await expect(cards).toBeVisible();
    await expect(page.getByTestId("workspace-exit-focus-mode")).toHaveCount(0);
    await expect(panes).toHaveCount(paneCount);
    expect(await cards.boundingBox()).toEqual(before);
  }
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("command-center-panel");
  await expect(palette).toBeVisible();
  await palette.getByTestId("command-center-input").fill("focus mode");
  await expect(palette.getByRole("button", { name: /Toggle focus mode/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const toggle = toolbar.getByTestId("workspace-explorer-toggle");
  await toggle.click();
  await expect(cards).toBeHidden();
  await toggle.click();
  await expect(cards).toBeVisible();
  await page.reload();
  await expect(row).toBeVisible();
  await expect(cards).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(sessionStorage.getItem("vorteo:demo:panel-state")!).version),
    )
    .toBe(20);
  const stored = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("vorteo:demo:panel-state")!).state,
  );
  expect(stored.desktop).not.toHaveProperty("focusModeEnabled");
  expect(stored.supportingCardExpanded.journal).toBe(false);
  expect(stored.inlineCardExpanded.tasks).toBe(false);
  await page.screenshot({ path: info.outputPath("normal-layout-after-focus-removal.png") });
});
