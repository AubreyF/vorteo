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
  await expect(
    page.getByTestId("workspace-shared-toolbar").getByTestId("workspace-explorer-toggle"),
  ).toBeVisible();
  await page
    .getByTestId("workspace-shared-toolbar")
    .getByTestId("workspace-explorer-toggle")
    .click();
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
  expect(contentMenuBounds.x + contentMenuBounds.width).toBeLessThanOrEqual(toggleBounds.x);
  await collapsedToggle.click();
  await expect(cards).toBeVisible();
  await page
    .getByTestId("workspace-shared-toolbar")
    .getByTestId("workspace-explorer-toggle")
    .click();
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
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(48);
  await expect(page.getByTestId("compact-project-rail")).toBeVisible();
  const railProject = page
    .getByTestId("compact-project-rail")
    .getByRole("button", { name: /^Atlas,/ });
  await page.keyboard.press("Tab");
  await railProject.focus();
  const railHelp = page.getByTestId("project-rail-preview");
  await expect(railHelp).toBeVisible();
  await expect(railHelp).toContainText("Atlas");
  await expect(railHelp.getByRole("button", { name: "Design review", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(railHelp.getByRole("button", { name: "Design review", exact: true })).toBeFocused();
  await page.mouse.move(900, 800);
  await page.waitForTimeout(350);
  await expect(railHelp).toBeVisible();
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
  const rightToolbar = page.getByTestId("workspace-shared-toolbar");
  await expect(rightToolbar).toBeVisible();
  const toolbarBounds = await Promise.all([
    page.getByTestId("sidebar-toolbar").boundingBox(),
    page.getByTestId("workspace-pane-main").getByTestId("workspace-tabs-row").boundingBox(),
    rightToolbar.boundingBox(),
  ]);
  for (const bounds of toolbarBounds) {
    expect(bounds!.height).toBe(48);
    expect(Math.abs(bounds!.y - toolbarBounds[1]!.y)).toBeLessThanOrEqual(8);
  }
  expect(toolbarBounds[2]!.y).toBe(toolbarBounds[1]!.y);
  const tasks = await page.getByTestId("agent-task-progress-card").boundingBox();
  // Animated transforms can retain subpixel floating-point residue at rest.
  expect(tasks!.y).toBeCloseTo(toolbarBounds[1]!.y + toolbarBounds[1]!.height, 3);
  await expect(page.getByTestId("workspace-supporting-cards")).toHaveCSS("border-width", "0px");
  await expect(page.getByTestId("screen-header").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId("workspace-tabs-row").first()).toHaveCSS(
    "border-bottom-width",
    "0px",
  );
  await expect(rightToolbar.getByTestId("workspace-toolbar-environment")).toHaveCount(0);
  const taskTab = page.getByRole("button", { name: "Prepare Atlas release notes", exact: true });
  await taskTab.hover();
  const tabTooltip = page.getByRole("tooltip");
  const environmentBadge = tabTooltip.getByTestId("host-badge-vorteo-demo");
  await expect(environmentBadge).toBeVisible();
  const metadata = environmentBadge.locator("..");
  await expect(metadata).toHaveText(/Demo.*·.*·/);
  expect((await environmentBadge.boundingBox())!.x).toBe((await metadata.boundingBox())!.x);
  await page.keyboard.press("Escape");
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
  // The floating card outline contributes one pixel to its resize track.
  expect(Math.abs(appearances[0].height - appearances[1].height)).toBeLessThanOrEqual(1);
  expect({ ...appearances[0], height: 0 }).toEqual({ ...appearances[1], height: 0 });
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
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(48);
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
  await page
    .getByTestId("workspace-shared-toolbar")
    .getByTestId("workspace-explorer-toggle")
    .click();
  await page.getByTestId("sidebar-collapse").click();
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(rail).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(48);
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

test("quiet card chrome keeps compact geometry across themes", async ({ page }, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
  const tasks = page.getByTestId("agent-task-progress-card");
  const journal = page.getByTestId("agent-journal-card");
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
    await page.mouse.move(900, 20);
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", theme);
    await expect(tasks.getByTestId("checklist-count")).toHaveText(/\d+ \/ \d+ open/);
    await expect(journal.locator('[data-testid^="journal-status-"]').first()).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    if (theme === "starship-light") {
      await expect(tasks).toHaveCSS("background-color", "rgb(238, 238, 246)");
      await expect(journal).toHaveCSS("background-color", "rgb(238, 238, 246)");
    }
    const inset = await tasks.getByTestId("checklist-toggle").evaluate((node) => {
      const box = node.getBoundingClientRect();
      const icon = node.firstElementChild!.getBoundingClientRect();
      return { left: icon.left - box.left, top: icon.top - box.top };
    });
    expect(inset.left).toBe(6);
    expect(inset.left).toBe(inset.top);
    const fills = await tasks
      .getByTestId("checklist-progress")
      .locator("path")
      .evaluateAll((paths) => [...new Set(paths.map((path) => getComputedStyle(path).fill))]);
    expect(fills.length).toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => {
        const a = (await tasks.boundingBox())!;
        return (await journal.boundingBox())!.y - a.y - a.height;
      })
      .toBeCloseTo(8, 0);
    const entry = journal.locator('[data-testid^="journal-entry-"]').first();
    const geometry = await entry.evaluate((node) => {
      const marker = node
        .querySelector('[data-testid^="journal-status-"]')!
        .getBoundingClientRect();
      const timestamp = node
        .querySelector('[data-testid="journal-timestamp"]')!
        .getBoundingClientRect();
      const text = node.querySelector('[data-testid="journal-text"]')!.getBoundingClientRect();
      return {
        markerCenter: marker.y + marker.height / 2,
        timestampCenter: timestamp.y + timestamp.height / 2,
        gap: text.y - timestamp.bottom,
      };
    });
    expect(geometry.markerCenter).toBeCloseTo(geometry.timestampCenter, 0);
    expect(geometry.gap).toBe(2);
    await page.screenshot({ path: info.outputPath(`quiet-${theme}.png`) });
  }
});

test("shares card disclosure preferences across workspaces and reloads without flashing open", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  const row = (id: string) =>
    page.getByTestId(`sidebar-workspace-row-vorteo-demo:demo-workspace-${id}`);
  const tasks = page.getByTestId("checklist-toggle").filter({ visible: true });
  const journal = page.getByTestId("agent-journal-toggle").filter({ visible: true });
  await row("0-1").click();
  await tasks.click();
  await journal.click();
  await expect(tasks).toHaveAttribute("aria-expanded", "false");
  await expect(journal).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => {
    const samples: string[] = [];
    Object.assign(window, { disclosureSamples: samples, sampleDisclosures: true });
    const sample = () => {
      if (!(window as unknown as { sampleDisclosures: boolean }).sampleDisclosures) return;
      for (const node of document.querySelectorAll(
        '[data-testid="checklist-toggle"], [data-testid="agent-journal-toggle"]',
      )) {
        if (node.checkVisibility()) samples.push(node.getAttribute("aria-expanded") ?? "missing");
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (const id of ["1-0", "2-0", "0-0", "1-1", "2-1", "0-1"]) {
    await row(id).click();
    await expect(tasks).toHaveAttribute("aria-expanded", "false");
    await expect(journal).toHaveAttribute("aria-expanded", "false");
  }
  const samples = await page.evaluate(() => {
    const state = window as unknown as { disclosureSamples: string[]; sampleDisclosures: boolean };
    state.sampleDisclosures = false;
    return state.disclosureSamples;
  });
  expect(samples.length).toBeGreaterThan(10);
  expect(samples.every((value) => value === "false")).toBe(true);
  await info.attach("disclosure-frames", {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
  await page.reload();
  await expect(tasks).toHaveAttribute("aria-expanded", "false");
  await expect(journal).toHaveAttribute("aria-expanded", "false");
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
  const files = page.getByTestId("supporting-card-files-toggle").filter({ visible: true });
  await expect(files).toHaveAttribute("aria-expanded", "true");
  await files.click();
  await page.reload();
  await expect(files).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
  await expect(files).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  // A fresh inline layout has its own defaults, independent of desktop choices.
  await expect(tasks).toHaveAttribute("aria-expanded", "true");
  await expect(journal).toHaveAttribute("aria-expanded", "true");
  await tasks.click();
  await journal.click();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect(tasks).toHaveAttribute("aria-expanded", "false");
  await expect(journal).toHaveAttribute("aria-expanded", "false");
  await tasks.click();
  await row("0-0").click();
  await expect(tasks).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tasks).toHaveAttribute("aria-expanded", "false");
  await expect(journal).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(tasks).toHaveAttribute("aria-expanded", "false");
  await expect(journal).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: info.outputPath("retained-card-preferences-phone.png") });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect(tasks).toHaveAttribute("aria-expanded", "true");
  await expect(journal).toHaveAttribute("aria-expanded", "false");
});

test("card spacing follows panel width on both sides and compact center layouts", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0").click();
  const card = page.getByTestId("agent-task-progress-card").filter({ visible: true });
  const left = page.getByTestId("floating-sidebar").filter({ visible: true });
  await expect(card).toBeVisible();
  for (const [handleId, target, direction] of [
    ["workspace-explorer-sidebar-resize-handle", card, -1],
    ["left-sidebar-resize-handle", left, 1],
  ] as const) {
    const handle = page.getByTestId(handleId).filter({ visible: true });
    const start = await handle.boundingBox();
    if (!start) throw new Error(`Missing ${handleId}`);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + direction * 180, start.y + start.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(() =>
        target.evaluate((node) => {
          const padded =
            node.dataset.testid === "floating-sidebar"
              ? node
              : node.firstElementChild!.firstElementChild!;
          return Number.parseFloat(getComputedStyle(padded).paddingLeft);
        }),
      )
      .toBe(8);
  }
  const row = page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0");
  for (const width of [280, 330, 360, 390, 450]) {
    const insets: number[] = [];
    for (const [handleId, target, direction] of [
      ["workspace-explorer-sidebar-resize-handle", card, -1],
      ["left-sidebar-resize-handle", left, 1],
    ] as const) {
      const handle = (await page.getByTestId(handleId).boundingBox())!;
      const before = (await target.boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        handle.x + handle.width / 2 + direction * (width - before.width),
        handle.y + handle.height / 2,
        { steps: 10 },
      );
      await page.mouse.up();
      let expected = 8;
      if (width < 400) expected = 4;
      if (width < 340) expected = 2;
      await expect
        .poll(() =>
          target.evaluate((node) => {
            const padded =
              node.dataset.testid === "floating-sidebar"
                ? node
                : node.firstElementChild!.firstElementChild!;
            return Number.parseFloat(getComputedStyle(padded).paddingLeft);
          }),
        )
        .toBe(expected);
      insets.push(expected);
    }
    expect(insets[0]).toBe(insets[1]);
    const outer = (await left.boundingBox())!;
    const highlighted = (await row.boundingBox())!;
    expect(highlighted.x - outer.x).toBeCloseTo(insets[0] + 1, 0);
    expect(outer.x + outer.width - highlighted.x - highlighted.width).toBeCloseTo(insets[0] + 1, 0);
    await page.screenshot({ path: info.outputPath(`matching-panel-insets-${width}.png`) });
  }
  await page.screenshot({ path: info.outputPath("spacious-panels.png"), fullPage: true });
  for (const width of [390, 280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card).toBeVisible();
    await expect
      .poll(() =>
        card.evaluate((node) => ({
          width: node.getBoundingClientRect().width,
          inset: Number.parseFloat(
            getComputedStyle(node.firstElementChild!.firstElementChild!).paddingLeft,
          ),
        })),
      )
      .toMatchObject({ inset: width === 280 ? 2 : 4 });
    await expect(page.getByTestId("checklist-toggle").filter({ visible: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.screenshot({ path: info.outputPath(`compact-panels-${width}.png`), fullPage: true });
  }
});

test("panel spacing animates between exact tiers and settles after interrupted resizing", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0").click();
  for (const [handleId, targetId, direction] of [
    ["left-sidebar-resize-handle", "floating-sidebar", 1],
    ["workspace-explorer-sidebar-resize-handle", "agent-task-progress-card", -1],
  ] as const) {
    const target = page.getByTestId(targetId).filter({ visible: true });
    const readInset = () =>
      target.evaluate((node) => {
        const padded =
          node.dataset.testid === "floating-sidebar"
            ? node
            : node.firstElementChild!.firstElementChild!;
        return Number.parseFloat(getComputedStyle(padded).paddingLeft);
      });
    const resize = async (width: number) => {
      const handle = (await page.getByTestId(handleId).boundingBox())!;
      const before = (await target.boundingBox())!;
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + direction * (width - before.width), y);
      await page.mouse.up();
    };
    await resize(280);
    await expect.poll(readInset).toBe(2);
    const samples = target.evaluate(async (node) => {
      const padded =
        node.dataset.testid === "floating-sidebar"
          ? node
          : node.firstElementChild!.firstElementChild!;
      const values: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 650) {
        values.push(Number.parseFloat(getComputedStyle(padded).paddingLeft));
        await new Promise(requestAnimationFrame);
      }
      return values;
    });
    await resize(450);
    await expect.poll(readInset).toBe(8);
    expect((await samples).some((value) => value > 2 && value < 8)).toBe(true);
    await resize(280);
    await resize(360);
    await expect.poll(readInset).toBe(4);
    await resize(390);
    await expect.poll(readInset).toBe(4);
  }
});

test("mobile keyboard viewport keeps workspace navigation above the composer", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0").click();
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = page
    .locator('textarea, [contenteditable="true"]')
    .filter({ visible: true })
    .first();
  await editor.focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => 450 },
      offsetTop: { configurable: true, get: () => 120 },
    });
    viewport.dispatchEvent(new Event("resize"));
  });
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThanOrEqual(120);
  const composer = page.getByTestId("message-input-root").filter({ visible: true });
  await expect
    .poll(async () => {
      const box = (await composer.boundingBox())!;
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(570);
  await page.screenshot({ path: info.outputPath("keyboard-visible-navigation.png") });
  await menu.click();
  await expect(
    page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0"),
  ).toBeVisible();
});

test("sidebar header divider stays visible at every list scroll position", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 360 });
  await page.goto("/?demo=1");
  const sidebar = page.getByTestId("floating-sidebar").filter({ visible: true });
  const toolbar = sidebar.getByTestId("sidebar-toolbar");
  const divider = sidebar.getByTestId("sidebar-toolbar-divider");
  const list = sidebar.getByTestId("sidebar-project-workspace-list-scroll");
  await expect(list).toBeVisible();
  const border = await sidebar.evaluate((node) => getComputedStyle(node).borderTopColor);
  await expect(divider).toHaveCSS("border-bottom-color", border);
  const bounds = (await sidebar.boundingBox())!;
  const line = (await divider.boundingBox())!;
  expect(line.x).toBeCloseTo(bounds.x + 1, 1);
  expect(line.width).toBeCloseTo(bounds.width - 2, 1);
  const initial = await toolbar.boundingBox();
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(divider).toHaveCSS("border-bottom-color", border);
  expect(await toolbar.boundingBox()).toEqual(initial);
  await page.screenshot({ path: info.outputPath("sidebar-scrolled-divider.png") });
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(divider).toHaveCSS("border-bottom-color", border);
  expect(await toolbar.boundingBox()).toEqual(initial);
});

test("shared toolbar flows left of a narrow card column without overlapping tabs", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0").click();
  const toolbar = page.getByTestId("workspace-shared-toolbar");
  const menu = toolbar.getByTestId("workspace-split-pane-menu");
  const toggle = toolbar.getByTestId("workspace-explorer-toggle");
  await expect(menu).toBeVisible();
  await expect(toggle).toBeVisible();
  const handle = page.getByTestId("workspace-explorer-sidebar-resize-handle");
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 80);
  await page.mouse.down();
  await page.mouse.move(grip.x + 180, grip.y + 80, { steps: 12 });
  await page.mouse.up();
  for (const width of [1800, 1150, 900]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(toggle).toBeVisible();
    await expect
      .poll(async () => {
        const m = (await menu.boundingBox())!;
        const t = (await toggle.boundingBox())!;
        const bar = (await toolbar.boundingBox())!;
        return m.x >= bar.x - 1 && t.x > m.x && Math.abs(t.x + t.width - (bar.x + bar.width)) <= 2;
      })
      .toBe(true);
    const tabs = page.getByTestId("workspace-tabs-row");
    const activeTab = tabs.getByRole("button", {
      name: "Review accessible navigation",
      exact: true,
    });
    await expect
      .poll(async () => {
        const tab = (await activeTab.boundingBox())!;
        const bar = (await toolbar.boundingBox())!;
        return tab.x + tab.width <= bar.x + 1;
      })
      .toBe(true);
    const controls = await toolbar.locator('button, [role="button"]').evaluateAll((nodes) =>
      nodes
        .filter((node) => node.checkVisibility())
        .map((node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right };
        })
        .sort((a, b) => a.left - b.left),
    );
    for (let index = 1; index < controls.length; index++) {
      expect(controls[index]!.left).toBeGreaterThanOrEqual(controls[index - 1]!.right - 1);
    }
    if (width === 1800) {
      expect((await toolbar.boundingBox())!.x).toBeLessThan(
        (await page.getByTestId("workspace-supporting-cards").boundingBox())!.x,
      );
    }
    await page.screenshot({ path: info.outputPath(`shared-toolbar-${width}.png`) });
  }
  await page.setViewportSize({ width: 1800, height: 1000 });
  await toggle.click();
  await expect(page.getByTestId("workspace-supporting-cards")).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(toggle).toBeVisible();
  await menu.click();
  await expect(page.getByTestId("workspace-split-pane-right")).toBeVisible();
  await expect(page.getByTestId("workspace-header-copy-path")).toBeVisible();
  await page.keyboard.press("Escape");
  await toggle.click();
  await expect(page.getByTestId("workspace-supporting-cards")).toBeVisible();
  await menu.click();
  await page.getByTestId("workspace-split-pane-right").click();
  await expect(menu).toBeVisible();
  await expect(toggle).toBeVisible();
  const maximize = page.getByTestId("workspace-maximize-pane").filter({ visible: true }).last();
  await maximize.click();
  await expect(menu).toBeVisible();
  await page.getByTestId("workspace-restore-pane").click();
  await expect(menu).toBeVisible();
});

test("sidebar drags into a compact rail with persistent controls and interactive project previews", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  const sidebar = page.getByTestId("floating-sidebar");
  const grip = page.getByTestId("left-sidebar-resize-handle");
  await expect(sidebar).toBeVisible();
  async function dragTo(width: number) {
    const b = (await grip.boundingBox())!;
    const s = (await sidebar.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + width, b.y + b.height / 2, { steps: 15 });
    await page.mouse.up();
  }
  await dragTo(220);
  await expect(
    page
      .getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0")
      .getByText("+1", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("sidebar-search")).toBeVisible();
  await expect(page.getByTestId("sidebar-schedules")).toHaveCount(0);
  await page.getByTestId("sidebar-footer-overflow").click();
  await expect(page.getByRole("menuitem", { name: "Schedules", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem").first()).toHaveText("Settings");
  await page.keyboard.press("Escape");
  await dragTo(180);
  await expect(page.getByTestId("compact-project-rail")).toHaveCount(0);
  await dragTo(155);
  await expect(page.getByTestId("compact-project-rail")).toBeVisible();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(48);
  const ids = ["sidebar-expand", "sidebar-search", "sidebar-schedules", "sidebar-sessions"];
  let previous = -1;
  for (const id of ids) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.y).toBeGreaterThan(previous);
    previous = box.y;
  }
  const project = page.locator('[data-testid^="project-rail-"]').first();
  const rail = page.getByTestId("compact-project-rail");
  const projectBounds = (await project.boundingBox())!;
  expect(projectBounds.y).toBeGreaterThan(previous);
  const menuBounds = (await page.getByTestId("sidebar-footer-overflow").boundingBox())!;
  const railBounds = (await rail.boundingBox())!;
  expect(menuBounds.y).toBeGreaterThan(projectBounds.y);
  expect(railBounds.y + railBounds.height - menuBounds.y - menuBounds.height).toBeLessThanOrEqual(
    4,
  );
  await expect(rail.getByRole("button", { name: "Add project", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await page.getByTestId("sidebar-footer-overflow").click();
  await expect(page.getByRole("menuitem").first()).toHaveText("Settings");
  await page.keyboard.press("Escape");

  await project.hover();
  const preview = page.getByTestId("project-rail-preview");
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "Design review", exact: true }).hover();
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "Design review", exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(page.getByText("Changes ready for review", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("compact-rail.png") });
  await page.reload();
  await expect(page.getByTestId("compact-project-rail")).toBeVisible();
  await dragTo(350);
  await expect(page.getByTestId("compact-project-rail")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-settings")).toBeVisible();
  await page.getByTestId("sidebar-footer-overflow").click();
  const theme = page.getByTestId("theme-preview-starship-light");
  const before = await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
  await theme.hover();
  await expect
    .poll(() => page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(before);
  await page.mouse.move(1300, 800);
  await expect
    .poll(() => page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(before);
  await page.screenshot({ path: info.outputPath("sidebar-menu.png") });
});

test.describe("touch project rail", () => {
  test.use({ hasTouch: true });
  test("keeps project previews and rail navigation usable without hover", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto("/?demo=1");
    await page.getByTestId("sidebar-collapse").click();
    await expect(page.getByTestId("compact-project-rail")).toBeVisible();
    for (const id of [
      "sidebar-expand",
      "sidebar-search",
      "sidebar-footer-overflow",
      "sidebar-schedules",
      "sidebar-sessions",
    ]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.locator('[data-testid^="project-rail-"]').first().tap();
    const preview = page.getByTestId("project-rail-preview");
    await expect(preview).toBeVisible();
    await page.screenshot({ path: info.outputPath("touch-project-preview.png") });
    await preview.getByRole("button", { name: "Design review", exact: true }).tap();
    await expect(preview).toHaveCount(0);
    await expect(page.getByText("Changes ready for review", { exact: true })).toBeVisible();
  });
});

for (const hasTouch of [false, true]) {
  test.describe(`sidebar width routing with touch ${hasTouch}`, () => {
    test.use({ hasTouch });
    test("uses the mobile overlay only below the viewport breakpoint", async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.goto("/?demo=1");
      const row = page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0");
      await row.click();
      await page.getByTestId("sidebar-collapse").click();
      await expect(page.getByTestId("compact-project-rail")).toBeVisible();
      await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
      await expect(row).toBeVisible();
      await page.setViewportSize({ width: 719, height: 900 });
      await expect(page.getByTestId("compact-project-rail")).toBeHidden();
      const toggle = page.getByRole("button", { name: "Open menu", exact: true });
      await expect(toggle).toHaveCount(1);
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(row).toBeVisible();
      await row.click();
      // The retained overlay leaves accessibility after its close animation settles.
      await expect(toggle).toHaveCount(1);
      await expect(toggle).toBeVisible();
      await page.setViewportSize({ width: 720, height: 900 });
      await expect(toggle).toBeHidden();
      await expect(page.getByTestId("compact-project-rail")).toBeVisible();
    });
  });
}

test("files card has joined hover corners and one scroll divider below its toolbar", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1800, height: 500 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0").click();
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
  const card = page.getByTestId("supporting-card-files").filter({ visible: true });
  const toggle = card.getByTestId("supporting-card-files-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.hover();
  await expect(toggle).toHaveCSS("border-top-left-radius", "8px");
  await expect(toggle).toHaveCSS("border-top-right-radius", "8px");
  await expect(toggle).toHaveCSS("border-bottom-left-radius", "0px");
  await expect(toggle).toHaveCSS("border-bottom-right-radius", "0px");
  const divider = card.getByTestId("files-pane-header-divider");
  const outer = card.getByTestId("supporting-card-files-scroll-divider");
  await expect(divider).toHaveCSS("opacity", "0");
  await expect(outer).toHaveCSS("opacity", "0");
  const scroll = card.getByTestId("file-explorer-tree-scroll");
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(divider).toHaveCSS("opacity", "1");
  await expect(outer).toHaveCSS("opacity", "0");
  const box = (await card.boundingBox())!;
  const line = (await divider.boundingBox())!;
  expect(line.x).toBeCloseTo(box.x + 1, 1);
  expect(line.width).toBeCloseTo(box.width - 2, 1);
  await card.screenshot({ path: info.outputPath("files-single-divider.png") });
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(divider).toHaveCSS("opacity", "0");
});
