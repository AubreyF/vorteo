import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

for (const width of [1900, 390]) {
  test(`card tooltips preserve keyboard focus and fit the viewport at ${width}px`, async ({
    page,
  }) => {
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
      const arrow = tooltip.getByTestId("tooltip-arrow");
      await expect(arrow).toBeVisible();
      await expect(arrow).toHaveAttribute("aria-hidden", "true");
      const bounds = await tooltip.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(12);
      expect(bounds!.y).toBeGreaterThanOrEqual(12);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 12);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(988);
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.getByTestId("subagents-group-paseo-toggle")).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });
}

test("Files and Changes share the floating conversation card group", async ({ page }) => {
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
  } finally {
    await agent.cleanup();
  }
});
