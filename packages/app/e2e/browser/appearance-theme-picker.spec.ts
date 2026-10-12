import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsSection } from "../support/helpers/settings";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { getTerminalBufferText, waitForTerminalContent } from "../support/helpers/terminal-perf";

test("updates a running terminal across all six themes without replacing its session", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  const harness = await TerminalE2EHarness.create({
    tempPrefix: "appearance-terminal-",
  });
  try {
    const instance = await harness.createTerminal({
      name: "Theme review",
      command: "/bin/sh",
      args: [],
    });
    try {
      await harness.openTerminal(page, { terminalId: instance.id });
      const terminal = harness.terminalSurface(page);
      await terminal.pressSequentially("echo THEME_BUFFER_RETAINED", {
        delay: 0,
      });
      await terminal.press("Enter");
      await waitForTerminalContent(
        page,
        (text) => text.split(/\r?\n/).some((line) => line.trim() === "THEME_BUFFER_RETAINED"),
        10_000,
      );
      const initialTerminal = await page.evaluateHandle(() => window.__paseoTerminal);
      for (const theme of [
        "starship-light",
        "starship-dark",
        "scriptorium",
        "midas",
        "ember",
        "neon",
      ]) {
        await page.getByTestId("sidebar-footer-overflow").click();
        await page.getByTestId(`theme-preview-${theme}`).click();
        await page.mouse.move(900, 950);
        const backdrop = page.getByRole("button", {
          name: "Menu backdrop",
          exact: true,
        });
        if (await backdrop.isVisible()) await backdrop.click({ position: { x: 900, y: 950 } });
        await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", theme);
        if (theme === "starship-light" || theme === "starship-dark") {
          await expect(
            page.getByTestId(`sidebar-workspace-row-${getServerId()}:${harness.workspaceId}`),
          ).toHaveCSS(
            "background-color",
            theme === "starship-light" ? "rgb(240, 240, 248)" : "rgb(44, 44, 46)",
          );
        }
        await expect
          .poll(() =>
            page.evaluate(() => {
              const background = window.__paseoTerminal?.options.theme?.background;
              const probe = document.createElement("span");
              probe.style.backgroundColor = background ?? "transparent";
              document.body.append(probe);
              const actual = getComputedStyle(probe).backgroundColor;
              probe.remove();
              const canvas = document.querySelector("[data-appearance-canvas]")!;
              return actual === getComputedStyle(canvas).backgroundColor;
            }),
          )
          .toBe(true);
        expect(
          await page.evaluate((original) => window.__paseoTerminal === original, initialTerminal),
        ).toBe(true);
        expect(await getTerminalBufferText(page)).toContain("THEME_BUFFER_RETAINED");
        await expect(terminal.locator(".xterm-rows")).toHaveCSS(
          "font-family",
          /monospace|Mono|Menlo/,
        );
        await page.screenshot({
          path: info.outputPath(`${theme}-terminal.png`),
        });
      }
      await terminal.click();
      await terminal.pressSequentially("echo THEME_SESSION_STILL_WORKS", {
        delay: 0,
      });
      await terminal.press("Enter");
      await waitForTerminalContent(
        page,
        (text) => text.split(/\r?\n/).some((line) => line.trim() === "THEME_SESSION_STILL_WORKS"),
        10_000,
      );
      await initialTerminal.dispose();
    } finally {
      await harness.killTerminal(instance.id);
    }
  } finally {
    await harness.cleanup();
  }
});

test("offers six reference themes with Dark Star selected by default", async ({
  page,
}, testInfo) => {
  await page.goto("/settings");
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("border-radius", "16px");
  const sidebarBounds = await sidebar.boundingBox();
  expect(sidebarBounds).not.toBeNull();
  expect(sidebarBounds!.x).toBe(8);
  expect(sidebarBounds!.y).toBe(8);
  expect(sidebarBounds!.y + sidebarBounds!.height).toBe(page.viewportSize()!.height - 8);
  await openSettingsSection(page, "appearance");

  await expect(page.getByTestId("theme-preview-starship-dark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const id of ["starship-light", "starship-dark", "scriptorium", "midas", "ember", "neon"]) {
    const swatch = page.getByTestId(`theme-preview-${id}`);
    await expect(swatch).toBeVisible();
    const box = await swatch.boundingBox();
    expect(box!.height).toBe(44);
    expect(box!.width).toBeLessThanOrEqual(56);
    const surface = await page.getByTestId(`theme-preview-surface-${id}`).boundingBox();
    expect(surface!.width).toBeGreaterThanOrEqual(48);
  }
  await page.screenshot({
    path: testInfo.outputPath("appearance-theme-picker.png"),
    fullPage: true,
  });
});

test("stacks font labels above inputs on compact screens", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toHaveCSS("border-radius", "16px");
  const navigationBounds = await sidebar.boundingBox();
  expect(navigationBounds).not.toBeNull();
  expect(navigationBounds!.x).toBe(8);
  expect(navigationBounds!.width).toBe(374);
  await page.screenshot({
    path: testInfo.outputPath("compact-settings-navigation.png"),
  });
  await page.goto("/settings/appearance");
  const label = page.getByText("Interface font", { exact: true });
  const input = page.getByLabel("Interface font family", { exact: true });
  await expect(input).toBeVisible();
  const labelBox = await label.boundingBox();
  const inputBox = await input.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(labelBox!.width).toBeGreaterThan(280);
  expect(inputBox!.y).toBeGreaterThan(labelBox!.y + labelBox!.height);
  expect(inputBox!.width).toBeGreaterThan(280);
  expect(inputBox!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("compact-appearance.png"),
  });
});

test("keeps the selected workspace visible in Starship", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "starship-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "starship-light" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(240, 240, 248)");
    await page.screenshot({
      path: testInfo.outputPath("starship-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("keeps the selected workspace visible in Dark Star", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "dark-star-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "starship-dark" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(44, 44, 46)");
    await page.screenshot({
      path: testInfo.outputPath("dark-star-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("applies the interface font size to settings text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiBaseFontSize: 21 }));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await expect(sectionTitle).toHaveCSS("font-size", "18px");

  const interfaceSizeInput = page.getByLabel("Interface font size");
  const contentSizeInput = page.getByLabel("Content font size");
  await expect(interfaceSizeInput).toHaveValue("21");
  await expect(contentSizeInput).toHaveValue("21");
  await interfaceSizeInput.fill("12");
  await interfaceSizeInput.press("Tab");

  await expect(interfaceSizeInput).toHaveValue("12");
  await expect(contentSizeInput).toHaveValue("21");
  await expect(sectionTitle).toHaveCSS("font-size", "10px");
});

test("restores each theme's typography when the interface override is cleared", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ theme: "midas", uiFontFamily: "Georgia" }),
    );
  });
  await page.goto("/settings/appearance");
  const input = page.getByLabel("Interface font family", { exact: true });
  const label = page.getByText("Interface font", { exact: true });
  await expect(input).toHaveValue("Georgia");
  await expect(input).toHaveAttribute("placeholder", /Iowan Old Style/);
  await expect(label).toHaveCSS("font-family", /Georgia/);
  await page.getByTestId("theme-preview-scriptorium").click();
  await expect(input).toHaveValue("Georgia");
  await expect(input).toHaveAttribute("placeholder", /Manrope/);
  await expect(label).toHaveCSS("font-family", /Georgia/);
  // Move the pointer off the swatches, as a user does when editing the field.
  // fill() alone leaves hover previews active while it focuses the input.
  await input.click();
  await input.fill("");
  await input.press("Tab");
  await expect(label).toHaveCSS("font-family", /Manrope/);
  await page.getByTestId("theme-preview-starship-dark").click();
  await expect(input).toHaveAttribute("placeholder", /Barlow/);
  await expect(label).toHaveCSS("font-family", /Barlow/);
});

test("previews compact theme swatches without saving and commits only on activation", async ({
  page,
}, info) => {
  await page.goto("/settings/appearance");
  const root = page.locator("html");
  const card = page.getByTestId("theme-preview-midas");
  await expect(card).toBeVisible();
  await card.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "A rescued scroll lit by candle and ambition.",
  );
  await expect(root).toHaveAttribute("data-vorteo-appearance", "midas");
  await expect(page.getByTestId("theme-preview-starship-dark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.mouse.move(0, 0);
  await expect(root).toHaveAttribute("data-vorteo-appearance", "starship-dark");
  await card.focus();
  await expect(root).toHaveAttribute("data-vorteo-appearance", "midas");
  await page.keyboard.press("Escape");
  await expect(root).toHaveAttribute("data-vorteo-appearance", "starship-dark");
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(root).toHaveAttribute("data-vorteo-appearance", "midas");
  await page.reload();
  await expect(root).toHaveAttribute("data-vorteo-appearance", "midas");
  await page.screenshot({
    path: info.outputPath("theme-preview-cards.png"),
    fullPage: true,
  });
});

test("restores the saved theme when storage is full and allows retry", async ({ page }) => {
  await page.goto("/settings/appearance");
  const darkStar = page.getByTestId("theme-preview-starship-dark");
  const midas = page.getByTestId("theme-preview-midas");
  await expect(darkStar).toHaveAttribute("aria-pressed", "true");
  // Exercise the browser's actual quota refusal, without replacing its storage API.
  await page.evaluate(() => {
    localStorage.removeItem("@paseo:app-settings");
    let index = 0;
    for (const size of [65536, 1024, 1]) {
      while (true) {
        try {
          localStorage.setItem(`theme-quota-${index}`, "x".repeat(size));
          index++;
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
          break;
        }
      }
    }
  });
  await midas.click();
  await expect(page.getByRole("alert")).toHaveText("Could not save the theme. Try again.");
  await expect(darkStar).toHaveAttribute("aria-pressed", "true");
  await expect(midas).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(0, 0);
  await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", "starship-dark");

  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("theme-quota-")) localStorage.removeItem(key);
    }
  });
  await midas.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(midas).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(midas).toHaveAttribute("aria-pressed", "true");
});

test.describe("touch theme swatches", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps six swatches compact and commits a theme with one tap", async ({ page }, info) => {
    await page.goto("/settings/appearance");
    const card = page.getByTestId("theme-preview-neon");
    await card.scrollIntoViewIfNeeded();
    expect((await card.boundingBox())!.height).toBe(44);
    expect((await page.getByTestId("theme-preview-surface-neon").boundingBox())!.width).toBe(48);
    await card.tap();
    await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", "neon");
    await expect(card).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.getByTestId("theme-preview-starship-light").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("compact-theme-cards.png") });
  });
});

test("keeps System appearance available without plugin themes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings/appearance");
  const picker = page.getByRole("button", {
    name: "Theme: Dark Star",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByRole("menuitem", { name: "System", exact: true }).click();
  await expect(page.getByRole("button", { name: "Theme: System", exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}").theme),
    )
    .toBe("auto");
  await page.reload();
  await expect(page.getByRole("button", { name: "Theme: System", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Theme: System", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByTestId("theme-preview-ember").click();
  await expect(page.getByRole("button", { name: "Theme: Ember", exact: true })).toBeVisible();
});
