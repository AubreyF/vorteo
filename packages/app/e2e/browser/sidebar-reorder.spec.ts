import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, setVortonMode } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function visibleBoundingBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error("Expected a visible draggable row");
  return box;
}

async function pressProjectRow(rows: Locator) {
  await rows.page().mouse.down();
}

async function pressWorkspaceRow(rows: Locator) {
  const solidScrimStop = rows
    .nth(0)
    .getByTestId("sidebar-workspace-trailing-scrim")
    .locator("stop")
    .nth(1);
  const hoverScrimColor = await solidScrimStop.getAttribute("stop-color");
  await rows.page().mouse.down();
  await expect.poll(() => solidScrimStop.getAttribute("stop-color")).not.toBe(hoverScrimColor);
}

async function quickDragFirstRowAfterSecond(
  rows: Locator,
  pressRow: (rows: Locator) => Promise<void>,
) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  const trailingScrim = rows.nth(0).getByTestId("sidebar-workspace-trailing-scrim");
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await expect(trailingScrim).toHaveCount(0);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

test("projects, workspaces, and pinned chats reorder with an immediate mouse drag", async ({
  page,
}) => {
  const firstProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-first-" });
  const secondProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-second-" });

  try {
    const secondWorkspace = await firstProject.client.createWorkspace({
      source: {
        kind: "directory",
        path: firstProject.repoPath,
        projectId: firstProject.projectId,
      },
      title: "Second workspace",
    });
    if (!secondWorkspace.workspace) {
      throw new Error(secondWorkspace.error ?? "Failed to seed a second workspace");
    }

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(firstProject.projectKey)}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(secondProject.projectKey)}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${firstProject.workspaceId}`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondWorkspace.workspace.id}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );

    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondProject.workspaceId}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
  } finally {
    await firstProject.cleanup();
    await secondProject.cleanup();
  }
});

test("dropping a workspace into another project opens recreation without moving the original", async ({
  page,
}) => {
  const source = await seedWorkspace({ repoPrefix: "recreation-source-" });
  const destination = await seedWorkspace({ repoPrefix: "recreation-destination-" });
  try {
    await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "First chat",
    });
    await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "Other chat",
    });
    await source.client.setWorkspacePinned(source.workspaceId, true);
    await destination.client.archiveWorkspace(destination.workspaceId);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await setVortonMode(page, true);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    await dragWorkspaceToProject(row, target);
    const modal = page.getByTestId("project-recreation-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("substantial context");
    await expect(modal).toContainText("recommend cancelling");
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(row).toBeVisible();
  } finally {
    await source.cleanup();
    await destination.cleanup();
  }
});

async function dragWorkspaceToProject(row: Locator, target: Locator) {
  const page = row.page();
  const from = await visibleBoundingBox(row);
  const to = await visibleBoundingBox(target);
  await page.mouse.move(from.x + 90, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 90, from.y + from.height / 2 + 8);
  await page.mouse.move(to.x + 90, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("recreation reports changed-source failures and starts only the reviewed chat in the destination", async ({
  page,
}) => {
  const source = await seedWorkspace({ repoPrefix: "recreation-chat-source-" });
  const destination = await seedWorkspace({ repoPrefix: "recreation-chat-destination-" });
  const profileClient = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "recreation-profiles",
  });
  const previous = (await profileClient.getDaemonConfig()).config.sharedProviderPreferences!;
  await profileClient.patchDaemonConfig({
    sharedProviderPreferences: {
      version: 1,
      revision: previous.revision,
      legacyProfiles: {},
      providers: {
        mock: {
          defaults: { model: "ten-second-stream", modeId: "load-test" },
          preferredModels: [],
          preferredThinkingOptions: [],
          workflows: [
            { id: "recreation-test-profile", name: "Recreation test profile", provider: "mock" },
          ],
          defaultWorkflowId: "recreation-test-profile",
        },
      },
    },
    expectedProviderPreferencesRevision: previous.revision,
  });
  try {
    const selected = await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "Selected chat",
    });
    const other = await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "Keep this other chat",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    await setVortonMode(page, true);
    await target.click();
    await dragWorkspaceToProject(row, target);
    await chooseRecreationChat(page, "Selected chat");
    await page
      .getByTestId("preset-handoff-context")
      .fill("Continue the selected chat in the destination project.");
    await source.client.updateAgent(selected.id, { name: "Selected chat changed" });
    await page.getByRole("button", { name: "Recreate anyway", exact: true }).click();
    await expect(page.getByTestId("preset-handoff-modal")).toContainText("The source task changed");
    expect(
      (await destination.client.fetchWorkspaces()).entries.filter(
        (entry) => entry.projectId === destination.projectId,
      ),
    ).toHaveLength(1);
    await page
      .getByTestId("preset-handoff-modal")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await dragWorkspaceToProject(row, target);
    await chooseRecreationChat(page, "Selected chat changed");
    await page
      .getByTestId("preset-handoff-context")
      .fill("Continue the selected chat in the destination project.");
    await page.screenshot({ path: test.info().outputPath("project-recreation-warning.png") });
    await page.getByRole("button", { name: "Recreate anyway", exact: true }).click();
    await expect(page.getByTestId("preset-handoff-modal")).toHaveCount(0, { timeout: 45_000 });
    const agents = (await source.client.fetchAgents()).entries.map((entry) => entry.agent);
    const successors = agents.filter((agent) => agent.id !== selected.id && agent.id !== other.id);
    expect(successors).toHaveLength(1);
    const successor = successors[0]!;
    expect(successor).toMatchObject({
      provider: "mock",
      model: "ten-second-stream",
      currentModeId: "load-test",
      title: "Selected chat changed",
    });
    expect(successor.workspaceId).not.toBe(source.workspaceId);
    const workspaces = (await destination.client.fetchWorkspaces()).entries;
    expect(workspaces.find((entry) => entry.id === successor.workspaceId)).toMatchObject({
      projectId: destination.projectId,
    });
    expect(
      agents
        .filter((agent) => agent.workspaceId === source.workspaceId)
        .map((agent) => agent.id)
        .sort(),
    ).toEqual([selected.id, other.id].sort());
    await expect(page).toHaveURL(new RegExp(successor.workspaceId!));
  } finally {
    await source.cleanup();
    await destination.cleanup();
    const current = (await profileClient.getDaemonConfig()).config.sharedProviderPreferences!;
    await profileClient.patchDaemonConfig({
      sharedProviderPreferences: previous,
      expectedProviderPreferencesRevision: current.revision,
    });
    await profileClient.close();
  }
});

async function chooseRecreationChat(page: Page, title: string) {
  await page.getByTestId("recreation-chat").getByRole("button").click();
  const chat = page.getByText(title, { exact: true }).last();
  await expect(chat).toBeVisible();
  await chat.click();
  await page.getByTestId("recreation-profile").getByRole("button").click();
  const profile = page.getByText("Recreation test profile", { exact: true }).last();
  await expect(profile).toBeVisible();
  await profile.click();
  await page.getByTestId("recreation-review").click();
  await expect(page.getByTestId("preset-handoff-modal")).toBeVisible();
}

test("cross-project drops do not open recreation in Standard mode", async ({ page }) => {
  const source = await seedWorkspace({ repoPrefix: "standard-drop-source-" });
  const destination = await seedWorkspace({ repoPrefix: "standard-drop-destination-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await setVortonMode(page, false);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    await dragWorkspaceToProject(row, target);
    await expect(page.getByTestId("project-recreation-modal")).toHaveCount(0);
    await expect(row).toBeVisible();
  } finally {
    await source.cleanup();
    await destination.cleanup();
  }
});
