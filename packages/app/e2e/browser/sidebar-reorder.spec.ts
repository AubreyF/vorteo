import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { Locator, WebSocketRoute } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  sidebarProjectForWorkspace,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

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
  await rows.page().mouse.down();
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
  // Start on the row inset, away from branch popovers and trailing actions.
  const source = { x: sourceBox.x + 12, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + 12, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

test("projects, workspaces, pinned chats and expansion synchronize between devices", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const firstProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-first-" });
  const secondProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-second-" });
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  let offline = false;
  let peerSocket: WebSocketRoute | undefined;
  let serverSocket: WebSocketRoute | undefined;
  await peer.routeWebSocket(
    (url) => url.port === String(getE2EDaemonPort()),
    async (socket) => {
      if (offline) {
        await socket.close({ code: 1013, reason: "Test connection outage" });
        return;
      }
      peerSocket = socket;
      serverSocket = socket.connectToServer();
    },
  );

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
    await expect
      .poll(async () => (await firstProject.client.readSidebarState()).snapshot.state !== null)
      .toBe(true);
    const storage = await page.context().storageState();
    await peerContext.addInitScript((origins) => {
      for (const origin of origins) {
        if (origin.origin !== window.location.origin) continue;
        for (const entry of origin.localStorage) {
          if (entry.name !== "@paseo:client-id-v1") localStorage.setItem(entry.name, entry.value);
        }
      }
    }, storage.origins);
    await peer.goto(page.url());
    await waitForSidebarHydration(peer);

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(firstProject.projectKey)}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(secondProject.projectKey)}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    await expect
      .poll(() =>
        rowTestIds(
          peer.locator(
            `[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`,
          ),
        ),
      )
      .toEqual(
        await rowTestIds(
          page.locator(
            `[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`,
          ),
        ),
      );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${firstProject.workspaceId}`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondWorkspace.workspace.id}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );

    await expect
      .poll(() =>
        rowTestIds(
          peer.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
          ),
        ),
      )
      .toEqual(
        await rowTestIds(
          page.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
          ),
        ),
      );
    await peer.getByTestId(firstProjectTestId).click();
    await expect(page.getByTestId(firstWorkspaceTestId)).toHaveCount(0);
    await peer.reload();
    await waitForSidebarHydration(peer);
    await expect(peer.getByTestId(firstWorkspaceTestId)).toHaveCount(0);
    await page.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId(firstWorkspaceTestId)).toBeVisible();

    // Browser offline emulation does not close an established WebSocket.
    offline = true;
    await Promise.all([peerSocket?.close(), serverSocket?.close()]);
    await peer.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId("sidebar-sync-error")).toBeVisible({ timeout: 20000 });
    offline = false;
    await expect(page.getByTestId(firstWorkspaceTestId)).toHaveCount(0);
    await expect(peer.getByTestId("sidebar-sync-error")).toHaveCount(0);
    await page.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId(firstWorkspaceTestId)).toBeVisible();

    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondProject.workspaceId}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
    await expect
      .poll(() =>
        rowTestIds(
          peer.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
          ),
        ),
      )
      .toEqual(
        await rowTestIds(
          page.locator(
            `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
          ),
        ),
      );
    await peer.screenshot({ path: "test-results/sidebar-state-synced.png" });
    await peer.mouse.move(900, 500);
    await peer.setViewportSize({ width: 390, height: 844 });
    await peer.getByRole("button", { name: "Open menu", exact: true }).click();
    await waitForSidebarHydration(peer);
    await expect(peer.getByTestId(secondWorkspaceTestId)).toBeVisible();
    await page.getByTestId(firstProjectTestId).click();
    await expect(peer.getByTestId(secondWorkspaceTestId)).toHaveCount(0);
    await peer.getByTestId(firstProjectTestId).click({ position: { x: 12, y: 16 } });
    await expect(peer.getByTestId(secondWorkspaceTestId)).toBeVisible();
    await expect(page.getByTestId(secondWorkspaceTestId)).toBeVisible();
    await peer.screenshot({ path: "test-results/sidebar-state-compact.png" });
  } catch (error) {
    await peer.screenshot({ path: "test-results/sidebar-state-peer-failure.png" });
    console.log("Sidebar state at failure", await firstProject.client.readSidebarState());
    throw error;
  } finally {
    offline = false;
    await Promise.all([firstProject.cleanup(), secondProject.cleanup()]);
    await peerContext.close();
  }
});

test("cancelling a workspace move preserves its project and chats", async ({ page }) => {
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
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    await dragWorkspaceToProject(row, target);
    const modal = page.getByTestId("project-move-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Move to project");
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

test("the workspace menu moves every chat together and preserves membership after reload", async ({
  page,
}) => {
  const source = await seedWorkspace({ repoPrefix: "move-source-" });
  const destination = await seedWorkspace({ repoPrefix: "move-destination-" });
  const inspector = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "project-move" });
  try {
    const first = await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "First retained chat",
    });
    const second = await source.client.createAgent({
      provider: "mock",
      cwd: source.repoPath,
      workspaceId: source.workspaceId,
      title: "Second retained chat",
    });
    const project = (await inspector.listProjects()).projects.find(
      (entry) => entry.projectId === destination.projectId,
    )!;
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const workspaceKey = `${getServerId()}:${source.workspaceId}`;
    const row = page.getByTestId(`sidebar-workspace-row-${workspaceKey}`);
    await row.hover();
    await page.getByTestId(`sidebar-workspace-kebab-${workspaceKey}`).click();
    await page.getByTestId(`sidebar-workspace-menu-move-project-${workspaceKey}`).click();
    await page.getByTestId("project-move-project").click();
    await page.getByText(project.projectDisplayName, { exact: true }).last().click();
    await page.getByTestId("project-move-confirm").click();
    await expect(page.getByTestId("project-move-modal")).toHaveCount(0);
    const destinationRowId = `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`;
    await expect.poll(() => sidebarProjectForWorkspace(row)).toBe(destinationRowId);
    const workspace = (await inspector.fetchWorkspaces()).entries.find(
      (entry) => entry.id === source.workspaceId,
    )!;
    expect(workspace).toMatchObject({
      projectId: source.projectId,
      workspaceDirectory: source.repoPath,
      projectMembership: {
        key: projectEquivalenceViewKey(destination.projectKey),
        name: project.projectDisplayName,
      },
    });
    const chats = (await source.client.fetchAgents()).entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.workspaceId === source.workspaceId);
    expect(chats.map((agent) => agent.id).sort()).toEqual([first.id, second.id].sort());
    expect(chats.map((agent) => agent.cwd)).toEqual([source.repoPath, source.repoPath]);
    await page.reload();
    await waitForSidebarHydration(page);
    await expect(row).toBeVisible();
    await expect.poll(() => sidebarProjectForWorkspace(row)).toBe(destinationRowId);
    expect(
      (await inspector.fetchWorkspaces()).entries.find((entry) => entry.id === source.workspaceId)
        ?.projectMembership,
    ).toEqual(workspace.projectMembership);
    await page.screenshot({ path: test.info().outputPath("moved-workspace.png") });
  } finally {
    await inspector.close();
    await source.client.archiveWorkspace(source.workspaceId).catch(() => undefined);
    await source.cleanup();
    await destination.cleanup();
  }
});

test("a failed move stays open with a visible error", async ({ page }) => {
  const source = await seedWorkspace({ repoPrefix: "move-failure-source-" });
  const destination = await seedWorkspace({ repoPrefix: "move-failure-destination-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
    const target = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
    );
    await dragWorkspaceToProject(row, target);
    await expect(page.getByTestId("project-move-modal")).toBeVisible();
    await source.client.archiveWorkspace(source.workspaceId);
    await page.getByTestId("project-move-confirm").click();
    await expect(page.getByTestId("project-move-modal")).toContainText(
      "Restore this workspace before moving it.",
    );
    await page
      .getByTestId("project-move-modal")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(page.getByTestId("project-move-modal")).toHaveCount(0);
  } finally {
    await source.cleanup();
    await destination.cleanup();
  }
});

for (const width of [1400, 390]) {
  test(`protected workspace drop explains the block at ${width}px`, async ({ page }) => {
    const source = await seedWorkspace({ repoPrefix: "protected-drop-source-" });
    const destination = await seedWorkspace({ repoPrefix: "protected-drop-destination-" });
    try {
      await source.client.setWorkspaceLifecycle({
        workspaceId: source.workspaceId,
        protected: true,
      });
      await page.setViewportSize({ width, height: 900 });
      await gotoAppShell(page);
      const menu = page.getByRole("button", { name: "Open menu", exact: true });
      if (await menu.isVisible()) await menu.click();
      await waitForSidebarHydration(page);
      const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${source.workspaceId}`);
      const target = page.getByTestId(
        `sidebar-project-row-${projectEquivalenceViewKey(destination.projectKey)}`,
      );
      const from = await visibleBoundingBox(row);
      const to = await visibleBoundingBox(target);
      await page.mouse.move(from.x + 90, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 90, from.y + from.height / 2 + 8);
      await page.mouse.move(to.x + 90, to.y + to.height / 2, { steps: 12 });
      await expect(page.getByTestId("project-drop-blocked")).toBeVisible();
      await expect(
        page.getByText(
          "This workspace is protected. Turn off protection in Workspace actions before moving it.",
          { exact: true },
        ),
      ).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("protected-drop.png") });
      await page.mouse.up();
      await expect(page.getByTestId("project-move-modal")).toHaveCount(0);
      expect(
        (await source.client.fetchWorkspaces()).entries.find(
          (entry) => entry.id === source.workspaceId,
        )?.projectMembership,
      ).toBeFalsy();
      await source.client.setWorkspaceLifecycle({
        workspaceId: source.workspaceId,
        protected: false,
      });
      await dragWorkspaceToProject(row, target);
      await expect(page.getByTestId("project-move-modal")).toBeVisible();
    } finally {
      await page.mouse.up();
      await source.client
        .setWorkspaceLifecycle({ workspaceId: source.workspaceId, protected: false })
        .catch(() => undefined);
      await source.cleanup();
      await destination.cleanup();
    }
  });
}
