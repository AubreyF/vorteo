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
  expect(tabsBounds!.height).toBe(48);
  await expect(page.getByTestId("screen-header").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId("workspace-tabs-row").first()).toHaveCSS(
    "border-bottom-width",
    "0px",
  );
  const taskTab = page.getByRole("button", { name: "Review accessible navigation", exact: true });
  await expect(taskTab).toHaveCSS("border-bottom-left-radius", "9999px");
  await expect(taskTab).toHaveCSS("border-top-left-radius", "9999px");
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
  const collapsedToggle = page.getByTestId("workspace-explorer-toggle");
  const contentMenu = page.getByTestId("workspace-split-pane-menu").filter({ visible: true });
  const toggleBounds = (await collapsedToggle.boundingBox())!;
  const contentMenuBounds = (await contentMenu.boundingBox())!;
  expect(toggleBounds.y + toggleBounds.height / 2).toBeCloseTo(
    contentMenuBounds.y + contentMenuBounds.height / 2,
    1,
  );
  expect(toggleBounds.x + toggleBounds.width).toBeLessThanOrEqual(contentMenuBounds.x);
  await collapsedToggle.click();
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
  const railHelp = page.getByRole("tooltip", { name: /^Atlas / });
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
  await expect(page.getByTestId("screen-header").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId("workspace-tabs-row").first()).toHaveCSS(
    "border-bottom-width",
    "0px",
  );
  const environment = rightToolbar.getByTestId("workspace-toolbar-environment");
  await expect(environment).toBeVisible();
  const toggle = (await rightToolbar.getByTestId("workspace-explorer-toggle").boundingBox())!;
  expect((await environment.boundingBox())!.x).toBeGreaterThanOrEqual(toggle.x + toggle.width);
  const taskTab = page.getByRole("button", { name: "Prepare Atlas release notes", exact: true });
  expect((await taskTab.boundingBox())!.width).toBeGreaterThan(160);
  expect((await taskTab.boundingBox())!.height).toBe(44);
  await expect(taskTab).toHaveCSS("border-width", "1px");
  await expect(taskTab).not.toHaveCSS("box-shadow", "none");
  await expect(
    page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }),
  ).toHaveCount(0);
  const settings = await page.getByTestId("sidebar-settings").boundingBox();
  const overflow = await page.getByTestId("sidebar-footer-overflow").boundingBox();
  expect(overflow!.x).toBeGreaterThan(settings!.x + settings!.width);
  await expect(rightToolbar.getByTestId("changes-primary-cta")).toHaveAccessibleName("Create PR");
  await page.getByTestId("workspace-split-pane-menu").filter({ visible: true }).click();
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

test("card cleanup icons explain their effects and cards use compact gaps", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0").click();
  for (const [id, label, detail] of [
    ["checklist-clear-completed", "Clear completed tasks", "Deletes completed Vorteo tasks"],
    ["journal-clear", "Clear journal", "Nothing is deleted"],
  ]) {
    const button = page.getByTestId(id);
    await expect(button).toHaveAccessibleName(label);
    await expect(button).toHaveText("");
    await page.mouse.move(900, 20);
    await page.keyboard.press("Tab");
    await button.focus();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(detail);
    await expect(button).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id"))!);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  }
  const tasks = page.getByTestId("agent-task-progress-card");
  const journal = page.getByTestId("agent-journal-card");
  await expect
    .poll(async () => {
      const first = (await tasks.boundingBox())!;
      return (await journal.boundingBox())!.y - first.y - first.height;
    })
    .toBeCloseTo(8, 1);
  await page.mouse.move(900, 20);
  await page.screenshot({ path: info.outputPath("compact-card-controls.png"), fullPage: true });
});

test("restores responsive sidebars without replacing manual preferences", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
  const sidebar = page.getByTestId("floating-sidebar").filter({ visible: true });
  const cards = page.getByTestId("workspace-supporting-cards");
  const rail = page.getByTestId("compact-project-rail");
  await expect(cards).toBeVisible();
  const expandedWidth = (await sidebar.boundingBox())!.width;
  // Files remains selected through automatic collapse and reopening.
  const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
  await expect(page.getByTestId("supporting-card-files")).toBeVisible();
  await page.setViewportSize({ width: 1300, height: 1000 });
  await expect(cards).toBeHidden();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(expandedWidth);
  await page.getByTestId("workspace-explorer-toggle").click();
  await expect(cards).toBeVisible();
  await page.setViewportSize({ width: 1290, height: 1000 });
  await expect(cards).toBeHidden();
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(rail).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(64);
  await expect(cards).toBeHidden();
  await rail.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(expandedWidth);
  await page.setViewportSize({ width: 790, height: 1000 });
  await expect(rail).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(790);
  await page.screenshot({ path: info.outputPath("responsive-rail.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath("responsive-phone.png") });
  await page.getByTestId("menu-button").click();
  await expect(page.getByTestId("sidebar-footer-overflow")).toBeVisible();
  await page.setViewportSize({ width: 380, height: 844 });
  await expect(page.getByTestId("sidebar-footer-overflow")).toBeHidden();
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(rail).toBeVisible();
  await expect(cards).toBeHidden();
  await page.setViewportSize({ width: 1300, height: 1000 });
  await expect(rail).toBeHidden();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(expandedWidth);
  await expect(cards).toBeHidden();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect(cards).toBeVisible();
  await page.screenshot({ path: info.outputPath("responsive-restored.png") });
  // A manual collapse stays collapsed through a resize cycle.
  await cards.getByTestId("workspace-explorer-toggle").click();
  await page.getByTestId("sidebar-collapse").click();
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(rail).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(240);
  await expect(cards).toBeHidden();
});

test("keeps cards docked through cold and retained workspace transitions", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  const row = (id: string) =>
    page.getByTestId(`sidebar-workspace-row-vorteo-demo:demo-workspace-${id}`);
  await expect(row("0-0")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    const samples: { x: number; right: number; dock: number | null }[] = [];
    Object.assign(window, { cardTransitionSamples: samples, sampleCardTransitions: true });
    const sample = () => {
      if (!(window as unknown as { sampleCardTransitions: boolean }).sampleCardTransitions) return;
      for (const cards of document.querySelectorAll(
        '[data-testid="agent-task-progress-card"], [data-testid="agent-journal-card"]',
      )) {
        const bounds = cards.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) continue;
        const dock = cards.closest('[data-testid="workspace-supporting-cards"]');
        samples.push({
          x: bounds.x,
          right: bounds.right,
          dock: dock?.getBoundingClientRect().x ?? null,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (const id of ["0-0", "1-0", "2-0", "0-1", "1-1", "2-1", "0-0", "1-0", "0-1"]) {
    await row(id).click();
    await expect(
      page.getByTestId("workspace-supporting-cards").filter({ visible: true }),
    ).toHaveCount(1);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          const next = () => {
            frames += 1;
            if (frames === 8) resolve();
            else requestAnimationFrame(next);
          };
          requestAnimationFrame(next);
        }),
    );
  }
  const samples = await page.evaluate(() => {
    const state = window as unknown as {
      sampleCardTransitions: boolean;
      cardTransitionSamples: { x: number; right: number; dock: number | null }[];
    };
    state.sampleCardTransitions = false;
    return state.cardTransitionSamples;
  });
  await info.attach("card-transition-frames", {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
  expect(samples.length).toBeGreaterThan(30);
  expect(
    samples.filter((sample) => sample.dock === null || sample.x < 1400 || sample.right > 1800),
  ).toEqual([]);
  const tasks = page.getByTestId("agent-task-progress-card").filter({ visible: true });
  await expect(tasks).toHaveCount(1);
  const before = (await tasks.boundingBox())!.height;
  const motion = tasks.evaluate(
    (node) =>
      new Promise<number[]>((resolve) => {
        const heights: number[] = [];
        const started = performance.now();
        const sample = () => {
          heights.push(node.getBoundingClientRect().height);
          if (performance.now() - started > 650) resolve(heights);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  await tasks.getByTestId("checklist-toggle").click();
  const heights = await motion;
  const after = (await tasks.boundingBox())!.height;
  expect(after).toBeLessThan(before);
  expect(heights.some((height) => height < before - 2 && height > after + 2)).toBe(true);
  await info.attach("card-height-animation", {
    body: JSON.stringify(heights),
    contentType: "application/json",
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await row("2-0").click();
  await row("0-1").click();
  await expect(tasks).toBeVisible();
  await page.screenshot({ path: info.outputPath("stable-workspace-cards.png") });
});
