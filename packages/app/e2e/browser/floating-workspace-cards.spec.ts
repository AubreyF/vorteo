import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

for (const width of [1900, 390]) {
  test(`card tooltips preserve keyboard focus and fit the viewport at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "tooltip-cards-",
      title: "Tooltip card review",
      initialPrompt: "emit 2 agent stream updates",
    });
    try {
      await agent.client.createAgent({
        provider: "mock",
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        title: "Tooltip fixture child",
        modeId: "load-test",
        model: "e2e-fast-stream",
        labels: { [PARENT_AGENT_ID_LABEL]: agent.agentId },
      });
      await openAgentRoute(page, agent);
      const trigger = page.getByTestId("subagents-group-paseo-info");
      await expect(trigger).toBeVisible();
      await page.keyboard.press("Tab");
      await trigger.focus();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toBeVisible();
      const tooltipId = await tooltip.getAttribute("id");
      expect(tooltipId).not.toBeNull();
      await expect(trigger).toHaveAttribute("aria-describedby", tooltipId!);
      await expect(tooltip).toHaveCSS("border-radius", "14px");
      const arrow = tooltip.getByTestId("tooltip-arrow");
      await expect(arrow).toBeVisible();
      await expect(arrow).toHaveAttribute("aria-hidden", "true");
      await expect(arrow).toHaveCSS("width", "10px");
      const bounds = await tooltip.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(12);
      expect(bounds!.y).toBeGreaterThanOrEqual(12);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 12);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(988);
      await page.screenshot({ path: info.outputPath(`rich-tooltip-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.getByTestId("subagents-group-paseo-toggle")).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });
}

test("Files and Changes share the floating conversation card group", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "floating-cards-",
    title: "Floating workspace cards",
    initialPrompt: "emit 2 agent stream updates",
  });
  try {
    await openAgentRoute(page, agent);
    await expect(page.locator("[data-pdisplay]").first()).toHaveCSS(
      "font-family",
      /Barlow Condensed/,
    );
    const group = page.getByTestId("workspace-supporting-cards");
    await expect(group).toBeVisible();
    await expect(group.getByTestId("agent-task-progress-card")).toBeVisible();
    const files = group.getByTestId("supporting-card-files");
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    if (!(await files.isVisible())) {
      // The sidebar toggle controls the whole group; Files/Changes commands reveal cards.
      await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
    }
    await expect(files).toBeVisible();
    await page.keyboard.press(mac ? "Meta+Shift+G" : "Control+Shift+G");
    await expect(group.getByTestId("supporting-card-changes_tree")).toBeVisible();
    await expect(page.getByTestId("workspace-explorer-sidebar")).toHaveCount(0);
    const toggle = files.getByTestId("supporting-card-files-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const tree = files.getByTestId("file-explorer-tree-scroll");
    await expect(tree).toBeVisible();
    await tree.evaluate((element) => element.setAttribute("data-retention-probe", "retained"));
    await toggle.click();
    await expect(tree).toBeHidden();
    await toggle.click();
    await expect(tree).toHaveAttribute("data-retention-probe", "retained");
    const chrome = await page.getByTestId("floating-sidebar").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        radius: style.borderRadius,
        border: style.borderColor,
      };
    });
    await expect(group).toHaveCSS("border-width", "0px");
    for (const card of [
      group.getByTestId("agent-task-progress-card"),
      files,
      group.getByTestId("supporting-card-changes_tree"),
    ]) {
      await expect(card).toHaveCSS("background-color", chrome.background);
      await expect(card).toHaveCSS("border-radius", chrome.radius);
      await expect(card).toHaveCSS("border-color", chrome.border);
    }
    const bounds = await group.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1892);
    expect(bounds!.y).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: info.outputPath("floating-workspace-cards.png") });
  } finally {
    await agent.cleanup();
  }
});

test("renders the floating workspace in all six themes", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-0").click();
  for (const id of ["starship-light", "starship-dark", "scriptorium", "midas", "ember", "neon"]) {
    await page.getByTestId("sidebar-footer-overflow").click();
    await page.getByTestId(`theme-preview-${id}`).click();
    await page.mouse.move(950, 950);
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", id);
    await expect(page.getByTestId("workspace-supporting-cards")).toBeVisible();
    await expect(page.getByText("Changes ready for review", { exact: true })).toHaveCSS(
      "font-family",
      /Barlow/,
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--paseo-display-font"),
        ),
      )
      .toMatch(/Barlow Condensed/);
    await page.screenshot({ path: info.outputPath(`${id}-workspace.png`) });
  }
});
