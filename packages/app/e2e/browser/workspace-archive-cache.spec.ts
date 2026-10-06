import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { waitForWorkspaceInReplicaCache } from "../support/helpers/replica-cache-storage";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectWorkspaceAbsentFromSidebar,
  selectWorkspaceInSidebar,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function archiveWorkspaceOutsideTheApp(workspace: SeededWorkspace): Promise<void> {
  const result = await workspace.client.archiveWorkspace(workspace.workspaceId);
  expect(result.error).toBeNull();
}

test.describe("Workspace archive cache coherence", () => {
  test("archiving a retained background workspace keeps the current workspace open", async ({
    page,
  }) => {
    const archived = await seedWorkspace({ repoPrefix: "archive-background-" });
    const selected = await seedWorkspace({ repoPrefix: "archive-selected-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, archived.workspaceId);
      await selectWorkspaceInSidebar(page, selected.workspaceId);
      const selectedUrl = page.url();
      await archiveWorkspaceOutsideTheApp(archived);
      await expectWorkspaceAbsentFromSidebar(page, archived.workspaceId);
      await expect(page).toHaveURL(selectedUrl);
      await expect(page.getByText("Workspace unavailable", { exact: true })).toHaveCount(0);
    } finally {
      await selected.cleanup();
      await archived.cleanup();
    }
  });

  test("an unknown workspace still reports that it is unavailable", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-missing-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      const missingUrl = page
        .url()
        .replace(encodeURIComponent(workspace.workspaceId), "missing-workspace");
      await page.goto(missingUrl);
      await expect(page.getByText("Workspace unavailable", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(missingUrl);
    } finally {
      await workspace.cleanup();
    }
  });

  test("an external archive leaves the selected workspace", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-cache-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      await waitForWorkspaceInReplicaCache(page, workspace.workspaceId);

      await archiveWorkspaceOutsideTheApp(workspace);

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      await expect(page).toHaveURL(/\/new\?/, { timeout: 30_000 });
      await expect(page.getByText("Workspace unavailable", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible();
      await test.info().attach("after-archive", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.reload();
      await waitForSidebarHydration(page);
      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
});
