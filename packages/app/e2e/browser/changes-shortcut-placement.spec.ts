import { expect, test } from "../support/fixtures";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const CHANGES_SHORTCUT = `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+G`;

test("Changes shortcut reveals the Changes tree in Explorer", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "changes-shortcut-explorer-" });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    await clickNewChat(page);

    await page.keyboard.press(CHANGES_SHORTCUT);

    // Files and Changes are supporting cards beside the conversation since 60f4899a6, 2e2921f79
    // and 73be0edc5, so the shortcut reveals the Changes card rather than an Explorer tab.
    const cards = page.getByTestId("workspace-supporting-cards").filter({ visible: true });
    await expect(cards.getByTestId("supporting-card-changes_tree")).toBeVisible({
      timeout: 30_000,
    });
    await expect(cards.getByTestId("changes-tree-panel")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
