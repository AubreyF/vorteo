import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import type { SeedDaemonClient } from "../support/helpers/seed-client";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";

// Isolated daemons start without the System project; this spec opts in.
test.use({ e2eDaemonEnvironment: { PASEO_SYSTEM_PROJECT: "1" } });

async function runnerWorkspaceId(client: SeedDaemonClient): Promise<string> {
  const { entries } = await client.fetchWorkspaces();
  const runner = entries.find(
    (entry) =>
      (entry as { systemMembership?: { role: string } }).systemMembership?.role ===
      "optimization-runner",
  );
  if (!runner) throw new Error("Expected the daemon to seed the Vorteo :: Optimizer workspace");
  return runner.id;
}

function runnerRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function systemProjectKey() {
  return `system:${getServerId()}`;
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("lists Vorteo System as a normal project and locks the runner's menu", async ({
    page,
    e2eWorkerClient,
  }, testInfo) => {
    const workspaceId = await runnerWorkspaceId(e2eWorkerClient);
    await gotoAppShell(page);
    await expect(page.getByTestId("sidebar-system-section")).toHaveCount(0);
    const projectRow = page.getByTestId(`sidebar-project-row-${systemProjectKey()}`);
    await expect(projectRow).toBeVisible();
    await expect(projectRow).toContainText("Vorteo System");
    const row = runnerRow(page, workspaceId);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Vorteo :: Optimizer");
    await page.screenshot({ path: testInfo.outputPath("vorteo-system-desktop.png") });

    await row.hover();
    await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${workspaceId}`).click();
    await expect(page.getByText("Managed by Vorteo System").first()).toBeVisible();
    for (const name of ["Archive", "Rename", "Move to project"]) {
      await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath("vorteo-system-desktop-menu.png") });
    await page.keyboard.press("Escape");

    await projectRow.hover();
    await page.getByTestId(`sidebar-project-kebab-${systemProjectKey()}`).click();
    await expect(
      page.getByTestId(`sidebar-project-menu-open-settings-${systemProjectKey()}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`sidebar-project-menu-remove-${systemProjectKey()}`),
    ).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("vorteo-system-desktop-project-menu.png") });
  });
});

test.describe("compact", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows the runner in the mobile sidebar", async ({ page, e2eWorkerClient }, testInfo) => {
    const workspaceId = await runnerWorkspaceId(e2eWorkerClient);
    await gotoAppShell(page);
    await openMobileAgentSidebar(page);
    await expect(runnerRow(page, workspaceId)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("vorteo-system-compact.png") });
  });
});
