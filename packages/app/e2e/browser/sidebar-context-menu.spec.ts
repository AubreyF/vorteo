import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  closeProjectContextMenu,
  closeWorkspaceContextMenu,
  expectProjectContextMenuActions,
  expectWorkspaceContextMenuActions,
  expectWorkspaceContextMenuOwnsAttention,
  expectWorkspaceRowHoverCleared,
  openProjectContextMenu,
  openWorkspaceContextMenu,
  showWorkspaceHoverCard,
} from "../support/helpers/sidebar";

test.describe("Sidebar context menus", () => {
  test("right-clicking workspace and project rows opens their actions at the pointer", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-context-menu-" });

    try {
      await gotoAppShell(page);

      await showWorkspaceHoverCard(page, workspace.workspaceId);
      await openWorkspaceContextMenu(page, workspace.workspaceId);
      await expectWorkspaceContextMenuActions(page, workspace.workspaceId);
      await expectWorkspaceContextMenuOwnsAttention(page);

      await closeWorkspaceContextMenu(page, workspace.workspaceId);
      await expectWorkspaceRowHoverCleared(page, workspace.workspaceId);
      await openProjectContextMenu(page, workspace.projectKey);
      await expectProjectContextMenuActions(page, workspace.projectKey);

      await closeProjectContextMenu(page, workspace.projectKey);
    } finally {
      await workspace.cleanup();
    }
  });
});

for (const width of [1024, 1133, 1600]) {
  // Geometry drift, owner review (2026-10-25): the project row measured 6px left and 8px right
  // padding (expected 6px on both sides) at 1024, 1133 and 1600px. No commit explains it.
  test.fixme(`project margins stay balanced with indented children at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 744 });
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-margins-" });
    try {
      await gotoAppShell(page);
      const project = page
        .getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(workspace.projectKey)}`)
        .filter({ visible: true });
      const child = page
        .getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`)
        .filter({ visible: true });
      await expect(project).toBeVisible();
      await expect(child).toBeVisible();
      const [parentBox, childBox] = await Promise.all(
        [project.locator(".."), child].map((row) =>
          row.evaluate((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return {
              left: parseFloat(style.paddingLeft),
              right: parseFloat(style.paddingRight),
              x: box.x,
              width: box.width,
            };
          }),
        ),
      );
      expect(parentBox.left).toBe(parentBox.right);
      expect(parentBox.left).toBe(6);
      expect(childBox.left).toBe(18);
      expect(Math.abs(childBox.x - parentBox.x)).toBeLessThan(2);
      expect(Math.abs(childBox.width - parentBox.width)).toBeLessThan(2);
      await page.screenshot({ path: test.info().outputPath(`project-margins-${width}.png`) });
    } finally {
      await workspace.cleanup();
    }
  });
}
