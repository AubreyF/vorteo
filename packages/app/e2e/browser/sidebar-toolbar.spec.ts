import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoAppShell } from "../support/helpers/app";

test("Vorton toolbar keeps navigation and sidebar actions above the projects", async ({ page }) => {
  const seeded = await seedWorkspace({ repoPrefix: "toolbar-layout-" });
  try {
    await page.goto("/open-project");

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
    await expect(page.getByTestId("sidebar-footer-overflow")).toBeVisible();
    await expect(page.getByText("Workspaces", { exact: true })).toHaveCount(0);
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

test.describe("macOS Search shortcuts", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
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
    await expect(page.getByTestId("sidebar-search")).toBeVisible();
    await page.getByTestId("sidebar-search").hover();
    const tooltip = page.getByTestId("sidebar-search-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Search");
    await expect(tooltip).toContainText("J");
    await expect(tooltip).toContainText("\u2423");
    await page.screenshot({ path: test.info().outputPath("search-shortcuts-tooltip.png") });
    await page.keyboard.press("Alt+Space");
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Alt+j");
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
  });
});

test("toolbar keeps navigation buttons visible until they would overlap", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  const sidebar = page.getByTestId("floating-sidebar");
  const grip = page.getByTestId("left-sidebar-resize-handle");
  const toolbar = page.getByTestId("sidebar-toolbar");
  await expect(toolbar).toBeVisible();
  const optional = [
    ["sidebar-schedules", "Schedules"],
    ["sidebar-sessions", "History"],
    ["sidebar-settings", "Settings"],
  ] as const;
  for (const width of [340, 330, 300, 270, 240, 210]) {
    const b = (await grip.boundingBox())!;
    const s = (await sidebar.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + width, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    const layout = await toolbar.evaluate((node) => ({
      width: node.getBoundingClientRect().width,
      // Help and View preferences keep hidden zero-size triggers under the menu button.
      buttons: [
        ...node.querySelectorAll(
          '[data-testid="sidebar-collapse"], [data-testid="sidebar-search"], [data-testid="sidebar-sessions"], [data-testid="sidebar-schedules"], [data-testid="sidebar-settings"], [data-testid="sidebar-footer-overflow"]',
        ),
      ]
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => ({ left: box.left, right: box.right })),
    }));
    // Buttons never overlap.
    const sorted = [...layout.buttons].sort((a, c) => a.left - c.left);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.left).toBeGreaterThanOrEqual(sorted[i - 1]!.right - 0.5);
    }
    // A button moves into the menu only when one more 44px button and the 8px group gap
    // would not fit.
    const shown = [];
    for (const [id] of optional) shown.push((await toolbar.getByTestId(id).count()) > 0);
    const visibleCount = shown.filter(Boolean).length;
    if (visibleCount < optional.length) {
      expect(layout.width).toBeLessThan((3 + visibleCount + 1) * 44 + 8);
    }
    expect(shown).toEqual(optional.map((_, index) => index < visibleCount));
    if (visibleCount > 0 && visibleCount < optional.length) {
      await toolbar.getByTestId("sidebar-footer-overflow").click();
      for (const [, label] of optional.slice(visibleCount)) {
        await expect(page.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
      }
      await page.keyboard.press("Escape");
    }
    if (width === 330) expect(visibleCount).toBe(optional.length);
  }
});
