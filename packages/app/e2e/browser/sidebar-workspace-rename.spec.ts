import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function workspaceRenameModalTestId(workspaceId: string, suffix: string): string {
  return `sidebar-workspace-rename-modal-${getServerId()}:${workspaceId}-${suffix}`;
}

async function openRenameModal(page: Page, workspaceId: string) {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const renameItem = page.getByTestId(`sidebar-workspace-menu-rename-${serverId}:${workspaceId}`);
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();

  const input = page.getByTestId(workspaceRenameModalTestId(workspaceId, "input"));
  await expect(input).toBeVisible({ timeout: 10_000 });
  return input;
}

// In Model B the workspace title is its identity: renaming sets a custom title
// layered over the derived branch/directory name, and reconciliation never
// touches it. The sidebar row shows the title verbatim — no branch mutation.
test.describe("Sidebar workspace rename", () => {
  test("renaming via kebab sets a custom title that survives reload", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-" });

    try {
      expect(workspace.workspaceName).toBe("main");

      await gotoAppShell(page);
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      const input = await openRenameModal(page, workspace.workspaceId);
      await expect(input).toHaveValue("main");

      const customTitle = "Payments Refactor";
      await input.fill(customTitle);
      await page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "submit")).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      // The title is shown exactly as typed — not slugified into a branch name.
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toContainText(
        customTitle,
        { timeout: 15_000 },
      );

      // The custom title is backing metadata on the workspace: a full reload
      // re-resolves the descriptor from persistence and must not lose it. This
      // exercises the same descriptor resolution reconciliation re-runs against,
      // so a reconcile pass cannot overwrite the user's title either.
      await page.reload();
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toContainText(
        customTitle,
        { timeout: 30_000 },
      );
    } finally {
      await workspace.cleanup();
    }
  });
});

test.describe("Vorton workspace double-click rename", () => {
  // A touchscreen laptop or iPad with a trackpad still receives mouse clicks.
  test.use({ hasTouch: true });

  test("double-clicking title text opens rename in both sidebar groupings", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-title-double-click-",
      title: "Rename gesture test",
    });
    try {
      await openAgentRoute(page, workspace);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const title = row.getByText("main", { exact: true });
      const input = page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "input"));
      const cancel = page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "cancel"));
      await expect(title).toBeVisible();

      await title.click();
      await expect(input).toHaveCount(0);
      await title.dblclick();
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("main");
      await cancel.click();
      await selectSidebarStatusGrouping(page);
      await title.dblclick();
      await expect(input).toBeVisible();
      await cancel.click();
    } finally {
      await workspace.cleanup();
    }
  });

  test("preserves single-click navigation and renames with double-click", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-double-click-" });
    try {
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      const input = page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "input"));
      await expect(row).toBeVisible({ timeout: 30_000 });

      await row.click();
      await expect(page).toHaveURL(new RegExp(`/workspace/${workspace.workspaceId}`));
      await expect(input).toHaveCount(0);
      await row.dblclick();
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("main");
      await input.fill("Unsaved suggestion draft");
      await page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "cancel")).click();
      await expect(row).toContainText("main");
      await selectSidebarStatusGrouping(page);
      await row.dblclick();
      await expect(input).toBeVisible();
      await input.fill("Renamed from status view");
      await page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "submit")).click();
      await expect(input).toHaveCount(0);
      await expect(row).toContainText("Renamed from status view");
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/workspace/${workspace.workspaceId}`));
      await expect(input).toHaveCount(0);
      await row.dblclick();
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("Renamed from status view");
      await page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "cancel")).click();
    } finally {
      await workspace.cleanup();
    }
  });
});
