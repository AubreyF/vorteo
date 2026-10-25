import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

function visibleNewTabPanel(page: Page): Locator {
  return page.getByTestId("workspace-new-tab-panel").filter({ visible: true });
}

async function expectLauncherSelection(launcher: Locator, name: string): Promise<void> {
  await expect(launcher.getByRole("button", { name, exact: true })).toBeFocused();
}

async function openExplorerWithKeyboard(page: Page): Promise<Locator> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+E`);
  // Files and Changes are supporting cards since 60f4899a6, 2e2921f79 and 73be0edc5.
  const explorer = page.getByTestId("workspace-supporting-cards").filter({ visible: true });
  await expect(explorer).toBeVisible({ timeout: 30_000 });
  return explorer;
}

test.describe("New tab keyboard launcher", () => {
  test("Cmd+E reveals the repository Changes card", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "explorer-keyboard-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      const explorer = await openExplorerWithKeyboard(page);
      // Cmd+E reveals the cards with their saved collapse state; only explicit Changes commands
      // expand the Changes card itself.
      await expect(explorer.getByTestId("supporting-card-changes_tree")).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });

  test("a new split pane focuses its launcher and supports arrow navigation", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "empty-pane-split-keyboard-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await clickNewChat(page);
      await runWorkspaceActionFromCommandCenter(page, "Split pane right");

      const launcher = visibleNewTabPanel(page);
      await expect(launcher).toBeVisible({ timeout: 30_000 });
      await expectLauncherSelection(launcher, "Agent");

      await page.keyboard.press("ArrowDown");
      await expectLauncherSelection(launcher, "Terminal");
      await page.keyboard.press("ArrowDown");
      await expectLauncherSelection(launcher, "Diff");
      await page.keyboard.press("Enter");

      await expect(
        page.getByTestId("workspace-tab-working_diff").filter({ visible: true }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
