import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function closeMenuSheet(page: Page): Promise<void> {
  const backdrop = page.getByRole("button", { name: "Bottom sheet backdrop" }).first();
  await backdrop.click({ position: { x: 12, y: 12 } });
  await expect(backdrop).not.toBeVisible({ timeout: 10_000 });
}

test("touch workspace rows have no kebab and the title menu contains workspace actions", async ({
  page,
}, testInfo) => {
  const seeded = await seedWorkspace({ repoPrefix: "sidebar-mobile-menu-sheet-" });

  try {
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await waitForSidebarHydration(page);

    await page
      .getByTestId(`sidebar-project-kebab-${projectEquivalenceViewKey(seeded.projectKey)}`)
      .click();

    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Project actions", { exact: true })).toBeVisible();
    await closeMenuSheet(page);

    const workspaceRow = page.getByTestId(
      `sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`,
    );
    await expect(
      workspaceRow.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${seeded.workspaceId}`),
    ).toHaveCount(0);
    await workspaceRow.tap();
    await page.getByTestId("workspace-header-menu-trigger").tap();

    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Workspace actions", { exact: true })).toBeVisible();
    // A mounted item can still be clipped while the content-sized sheet opens.
    await expect(page.getByTestId("workspace-header-copy-path")).toBeInViewport();
    for (const action of [
      "copy-path",
      "copy-branch-name",
      "rename",
      "move-project",
      "pin",
      "labels",
      "import-agent",
      "archive",
    ]) {
      await expect(page.getByTestId(`workspace-header-${action}`)).toBeVisible();
    }
    await page.screenshot({
      path: testInfo.outputPath("compact-menu.png"),
      animations: "disabled",
    });
    await page.getByTestId("workspace-header-move-project").tap();
    await expect(page.getByTestId("project-move-modal")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).tap();
    await page.getByTestId("workspace-header-menu-trigger").tap();
    await page.getByTestId("workspace-header-rename").tap();
    const input = page.getByTestId("workspace-header-rename-modal-input");
    await input.fill("Touch workspace menu");
    await page.getByTestId("workspace-header-rename-modal-submit").tap();
    await expect(page.getByTestId("workspace-header-title")).toHaveText("Touch workspace menu");
    await page.getByTestId("workspace-header-menu-trigger").tap();
    await page.getByTestId("workspace-header-labels").tap();
    await expect(page.getByTestId("workspace-label-picker-create")).toBeVisible();
    await closeMenuSheet(page);
    await page.getByTestId("workspace-header-menu-trigger").tap();
    await page.getByTestId("workspace-header-archive").tap();
    await expect(page).not.toHaveURL(new RegExp(`/workspace/${seeded.workspaceId}`));
  } finally {
    await seeded.cleanup();
  }
});
