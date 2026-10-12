import { expect, test } from "../support/fixtures";

test("opens a populated demo without connecting to a real host", async ({ page }, info) => {
  const sockets: string[] = [];
  const invalidDomProps: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /uniProps|transform-origin|accessibilityElementsHidden|importantForAccessibility|cannot contain a nested|cannot be a descendant/.test(
        message.text(),
      )
    ) {
      invalidDomProps.push(message.text());
    }
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  const workspace = page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0");
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  const project = page.locator('[data-testid^="sidebar-project-row-"]').first();
  await expect(project.locator("button")).toHaveCount(0);
  const projectActions = page.locator('[data-testid^="sidebar-project-kebab-"]').first();
  await project.hover();
  await projectActions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Open project settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await project.focus();
  await page.keyboard.press("Enter");
  await expect(workspace).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(workspace).toBeVisible();
  await workspace.click();
  await expect(
    page.getByText("Review accessible navigation", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Changes ready for review", { exact: true })).toBeVisible();
  const tabsBounds = await page
    .getByTestId("workspace-pane-main")
    .getByTestId("workspace-tabs-row")
    .boundingBox();
  const titleBounds = await page.getByTestId("screen-header").boundingBox();
  expect(tabsBounds!.y + tabsBounds!.height).toBeLessThanOrEqual(titleBounds!.y);
  const taskTab = page.getByRole("button", { name: "Review accessible navigation", exact: true });
  await expect(taskTab).toHaveCSS("border-bottom-left-radius", "0px");
  await expect(taskTab).toHaveCSS("border-top-left-radius", "8px");
  await expect(page.getByTestId("workspace-explorer-sidebar-resize-handle")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const cards = page.getByTestId("workspace-supporting-cards");
  await expect(cards.getByTestId("workspace-explorer-toggle")).toBeVisible();
  await cards.getByTestId("workspace-explorer-toggle").click();
  await expect(cards).toBeHidden();
  await expect(
    page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }),
  ).toHaveCount(0);
  await page.getByTestId("workspace-split-pane-menu").filter({ visible: true }).click();
  await expect(page.getByTestId("workspace-header-copy-path")).toBeVisible();
  await expect(page.getByTestId("workspace-split-pane-right")).toBeVisible();
  await page.getByTestId("workspace-header-labels").click();
  await expect(page.getByTestId("workspace-label-picker-create")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-split-pane-menu").filter({ visible: true }).click();
  await page.getByTestId("workspace-header-rename").click();
  await expect(page.getByTestId("workspace-header-rename-modal-input")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("workspace-split-pane-menu").filter({ visible: true }).click();
  await expect(page.getByTestId("workspace-header-copy-path")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-explorer-toggle").click();
  await expect(cards).toBeVisible();
  await cards.getByTestId("workspace-explorer-toggle").click();
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
  await expect(cards).toBeVisible();
  await page.getByTestId("sidebar-footer-overflow").click();
  await expect(page.getByTestId("theme-preview-scriptorium")).toBeVisible();
  await page.getByTestId("theme-preview-scriptorium").click();
  await page.mouse.move(800, 900);
  await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", "scriptorium");
  await page.keyboard.press("Escape");
  const sidebar = page.getByTestId("floating-sidebar");
  const expandedWidth = (await sidebar.boundingBox())!.width;
  await expect(page.getByText("Compact", { exact: true })).toHaveCount(0);
  await page.getByTestId("sidebar-collapse").click();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(240);
  await expect(page.getByTestId("sidebar-collapse")).toHaveAccessibleName("Minimize sidebar");
  await expect(workspace).toBeVisible();
  const compactBounds = (await sidebar.boundingBox())!;
  const menuBounds = (await page.getByTestId("sidebar-footer-overflow").boundingBox())!;
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(
    compactBounds.x + compactBounds.width,
  );
  await page.screenshot({ path: info.outputPath("compact-sidebar.png") });
  await page.reload();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(240);
  await page.getByTestId("sidebar-collapse").click();
  await expect(page.getByTestId("compact-project-rail")).toBeVisible();
  const railProject = page
    .getByTestId("compact-project-rail")
    .getByRole("button", { name: /^Atlas,/ });
  await page.keyboard.press("Tab");
  await railProject.focus();
  const railHelp = page.getByRole("tooltip");
  await expect(railHelp).toBeVisible();
  await expect(railHelp).toHaveCSS("opacity", "1");
  await expect(railHelp).toContainText("Atlas");
  await expect(railProject).toHaveAttribute(
    "aria-describedby",
    (await railHelp.getAttribute("id"))!,
  );
  const railBounds = (await railProject.boundingBox())!;
  const helpBounds = (await railHelp.boundingBox())!;
  expect(helpBounds.x).toBeGreaterThanOrEqual(railBounds.x + railBounds.width);
  const arrowBounds = (await railHelp.getByTestId("tooltip-arrow").boundingBox())!;
  const helpBorder = await railHelp.evaluate((node) =>
    parseFloat(getComputedStyle(node).borderLeftWidth),
  );
  expect(arrowBounds.x + arrowBounds.width / 2).toBeCloseTo(helpBounds.x + helpBorder, 0);
  await page.screenshot({ path: info.outputPath("minimal-rail-tooltip.png") });
  await page.keyboard.press("Escape");
  await expect(railHelp).toHaveCount(0);
  await expect(railProject).toBeFocused();
  await page.reload();
  await expect(page.getByTestId("compact-project-rail")).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(page.getByTestId("sidebar-toolbar")).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(expandedWidth);
  await page.keyboard.press(mac ? "Meta+b" : "Control+.");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(240);
  await page.keyboard.press(mac ? "Meta+b" : "Control+.");
  await expect(page.getByTestId("compact-project-rail")).toBeVisible();
  await page.keyboard.press(mac ? "Meta+b" : "Control+.");
  await expect(page.getByTestId("sidebar-toolbar")).toBeVisible();
  await expect(page.getByTestId("supporting-card-files")).toBeVisible();

  await expect(page.getByText("README.md", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("demo-controls")).toBeVisible();
  await expect(page.getByTestId("agent-task-progress-card")).toBeVisible();
  await expect(page.getByRole("progressbar").first().locator("svg")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(page.getByTestId("agent-journal-card")).toBeVisible();
  await expect(page.getByTestId("sidebar-vorton-compatibility")).toHaveCount(0);
  await page.mouse.move(900, 20);
  await page.screenshot({ path: info.outputPath("demo-workspace.png"), fullPage: true });
  expect(sockets.filter((url) => !url.includes("hot") && !url.includes("message"))).toEqual([]);
  expect(invalidDomProps).toEqual([]);
});

test("fits the sidebar theme menu on a narrow screen", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1");
  await page.getByTestId("menu-button").click();
  await page.getByTestId("sidebar-footer-overflow").click();
  const swatches = page.locator('[data-testid^="theme-preview-surface-"]');
  await expect(swatches).toHaveCount(6);
  for (const swatch of await swatches.all()) {
    const bounds = await swatch.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId("theme-preview-ember").focus();
  await page.keyboard.press("Enter");
  await page.mouse.move(380, 800);
  await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", "ember");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath("sidebar-menu-390.png"), fullPage: true });
});

test("aligns column toolbars and shares sidebar resize behavior", async ({ page }, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
  const rightToolbar = page.getByTestId("workspace-supporting-toolbar");
  await expect(rightToolbar).toBeVisible();
  const toolbarBounds = await Promise.all([
    page.getByTestId("sidebar-toolbar").boundingBox(),
    page.getByTestId("workspace-pane-main").getByTestId("workspace-tabs-row").boundingBox(),
    rightToolbar.boundingBox(),
  ]);
  for (const bounds of toolbarBounds) {
    expect(bounds!.height).toBe(48);
    expect(bounds!.y).toBe(toolbarBounds[0]!.y);
  }
  const tasks = await page.getByTestId("agent-task-progress-card").boundingBox();
  // Animated transforms can retain subpixel floating-point residue at rest.
  expect(tasks!.y).toBeCloseTo(toolbarBounds[0]!.y + toolbarBounds[0]!.height, 3);
  await expect(page.getByTestId("workspace-supporting-cards")).toHaveCSS("border-width", "0px");
  const headerRule = await page.getByTestId("screen-header").evaluate((node) =>
    [...node.querySelectorAll("div")].some((child) => {
      const style = getComputedStyle(child);
      return (
        parseFloat(style.borderBottomWidth) > 0 && style.borderBottomColor !== "rgba(0, 0, 0, 0)"
      );
    }),
  );
  expect(headerRule).toBe(false);
  const taskTab = page.getByRole("button", { name: "Prepare Atlas release notes", exact: true });
  expect((await taskTab.boundingBox())!.width).toBeGreaterThan(160);
  const settings = await page.getByTestId("sidebar-settings").boundingBox();
  const overflow = await page.getByTestId("sidebar-footer-overflow").boundingBox();
  expect(overflow!.x).toBeGreaterThan(settings!.x + settings!.width);
  await expect(rightToolbar.getByTestId("changes-primary-cta")).toHaveAccessibleName("Create PR");
  await rightToolbar.getByTestId("workspace-header-menu-trigger").click();
  await expect(page.getByTestId("workspace-header-copy-path")).toBeVisible();
  await page.keyboard.press("Escape");

  const widths: Record<string, number> = {};
  const appearances = [];
  for (const [handleId, panelId, delta] of [
    ["left-sidebar-resize-handle", "floating-sidebar", 40],
    ["workspace-explorer-sidebar-resize-handle", "workspace-supporting-cards", -40],
  ] as const) {
    const handle = page.getByTestId(handleId);
    const panel = page.getByTestId(panelId);
    const before = (await panel.boundingBox())!.width;
    await handle.hover();
    const highlight = page.getByTestId(`${handleId}-highlight`);
    await expect
      .poll(() => highlight.evaluate((node) => Number(getComputedStyle(node).opacity)))
      .toBeCloseTo(0.22 * 0.82, 3);
    appearances.push(
      await highlight.evaluate((node) => {
        const style = getComputedStyle(node);
        const bounds = node.getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          color: style.backgroundColor,
          radius: style.borderRadius,
        };
      }),
    );
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, 500);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + delta, 500, { steps: 12 });
    await expect
      .poll(() => highlight.evaluate((node) => Number(getComputedStyle(node).opacity)))
      .toBeCloseTo(0.34, 3);
    await page.mouse.up();
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeCloseTo(before + 40, 0);
    widths[panelId] = before + 40;
  }
  expect(appearances[0]).toEqual(appearances[1]);
  expect(appearances[0].width).toBe(2);
  await page.reload();
  for (const [panelId, width] of Object.entries(widths)) {
    await expect
      .poll(async () => (await page.getByTestId(panelId).boundingBox())?.width)
      .toBeCloseTo(width, 0);
  }
  await page.getByTestId("sidebar-footer-overflow").click();
  await page.getByTestId("theme-preview-scriptorium").click();
  await page.mouse.move(900, 980);
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", "scriptorium");
  const tint = await page.evaluate(() => {
    const color = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content;
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const metadataColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      metadataColor,
      body: getComputedStyle(document.body).backgroundColor,
      root: getComputedStyle(document.documentElement).backgroundColor,
      canvas: getComputedStyle(document.querySelector("[data-appearance-canvas]")!).backgroundColor,
      content: getComputedStyle(document.querySelector('[data-testid="workspace-pane-main"]')!)
        .backgroundColor,
    };
  });
  expect(new Set(Object.values(tint)).size).toBe(1);
  await page.screenshot({ path: info.outputPath("aligned-toolbars.png"), fullPage: true });
});

for (const theme of ["starship-light", "starship-dark", "scriptorium", "midas", "ember", "neon"]) {
  test(`themed editing surfaces remain usable in ${theme}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto("/?demo=1");
    await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
    await page.getByTestId("sidebar-footer-overflow").click();
    await page.getByTestId(`theme-preview-${theme}`).click();
    await page.mouse.move(900, 20);
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", theme);

    const tab = page.getByRole("button", { name: "Prepare Atlas release notes", exact: true });
    await tab.click({ button: "right" });
    const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
    await expect(rename).toBeVisible();
    await expect
      .poll(() =>
        rename.evaluate((node) => {
          let opacity = 1;
          for (let current: Element | null = node; current; current = current.parentElement) {
            opacity *= Number(getComputedStyle(current).opacity);
          }
          return opacity;
        }),
      )
      .toBe(1);
    await page.screenshot({ path: info.outputPath(`${theme}-menu.png`) });
    await rename.click();
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("textbox");
    await expect(input).toBeVisible();
    await input.fill("");
    await expect(dialog.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
    await input.fill("Theme surface review");
    await expect(input).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Rename", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`${theme}-dialog.png`) });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();

    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
    const files = page.getByTestId("supporting-card-files");
    await files.getByText("README.md", { exact: true }).click();
    const pane = page.getByTestId("workspace-file-pane").filter({ visible: true });
    await pane.getByRole("button", { name: "Source", exact: true }).click();
    const editor = pane.locator(".cm-content");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveCSS("font-family", /monospace|Mono/);
    await expect(editor).toContainText("simulated data");
    await page.keyboard.press(mac ? "Meta+Shift+G" : "Control+Shift+G");
    await expect(page.getByTestId("supporting-card-changes_tree")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${theme}-editor-files.png`) });
    await editor.fill("# Atlas\n\nTheme surface review.\n");
    await page.keyboard.press(mac ? "Meta+s" : "Control+s");
    const changes = page.getByTestId("supporting-card-changes_tree");
    await changes.getByText("README.md", { exact: true }).click();
    await expect(page.getByTestId("git-diff-canvas").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("diff-file-0").filter({ visible: true })).toHaveAccessibleName(
      "README.md, +3, -5",
    );
    await page.screenshot({ path: info.outputPath(`${theme}-diff.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1800,
    );
  });
}
