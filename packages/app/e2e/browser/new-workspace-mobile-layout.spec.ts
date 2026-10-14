import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

for (const [width, height] of [
  [390, 844],
  [375, 667],
  [430, 932],
]) {
  test(`mobile workspace header and bottom alignment at ${width}x${height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 24, bottom: 34, left: 0, right: 0 },
    });
    const workspace = await seedWorkspace({ repoPrefix: "mobile-workspace-layout-" });
    try {
      const query = new URLSearchParams({
        serverId: getServerId(),
        projectId: workspace.projectId,
        dir: workspace.repoPath,
        name: workspace.projectDisplayName,
      });
      await page.goto(`/new?${query}`);
      const title = page.getByTestId("new-workspace-header-title");
      const project = page.getByTestId("new-workspace-project-picker-trigger");
      await expect(title).toBeVisible();
      await expect(project).toContainText(workspace.projectDisplayName);
      const menu = page.getByTestId("menu-button").filter({ visible: true }).first();
      const titleBox = (await title.boundingBox())!;
      const menuBox = (await menu.boundingBox())!;
      expect(titleBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width);
      const header = (await page
        .getByTestId("screen-header")
        .filter({ visible: true })
        .first()
        .boundingBox())!;
      const projectBox = (await project.boundingBox())!;
      expect(projectBox.y).toBeGreaterThanOrEqual(header.y);
      expect(projectBox.y + projectBox.height).toBeLessThanOrEqual(header.y + header.height + 1);
      const composer = page.getByTestId("composer-input-area").filter({ visible: true });
      await expect(composer).toBeVisible();
      const composerBox = (await composer.boundingBox())!;
      expect(Math.abs(height - composerBox.y - composerBox.height)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`mobile-new-workspace-${width}.png`) });
      await project.click();
      await expect(page.getByPlaceholder("Search projects")).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
}
