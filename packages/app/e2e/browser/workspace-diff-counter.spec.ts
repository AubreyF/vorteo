import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";

// The composer's diff pill and the Standard mode that showed it went in 471d7f22a, so the counter
// lives only in the workspace toolbar, which shows its actions while the supporting cards are open.

async function openChangedWorkspace(page: Page) {
  const workspace = await seedWorkspace({
    repoPrefix: "toolbar-diff-",
    repo: {
      withRemote: true,
      files: [{ path: "counter.txt", content: "before\n" }],
      paseoConfig: { scripts: { check: { type: "task", command: "echo checked" } } },
    },
  });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Counter placement",
    modeId: "load-test",
    model: "ten-second-stream",
  });
  await rm(path.join(workspace.repoPath, "remote.git"), { recursive: true });
  await writeFile(path.join(workspace.repoPath, "counter.txt"), "after\nmore\n");
  await workspace.client.checkoutRefresh(workspace.repoPath);
  await expect
    .poll(async () => {
      const result = await workspace.client.fetchWorkspaces();
      return result.entries.find((entry) => entry.id === workspace.workspaceId)?.diffStat;
    })
    .toEqual({ additions: 2, deletions: 1 });
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
  return workspace;
}

test("diff counter sits before the scripts button and opens Changes", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const workspace = await openChangedWorkspace(page);
  try {
    await ensureExplorerSidebar(page);
    const counter = page.getByTestId("workspace-diff-counter").filter({ visible: true });
    await expect(counter).toBeVisible({ timeout: 30_000 });
    await expect(counter).toContainText("+2");
    await expect(counter).toContainText("-1");
    const runner = page.getByTestId("workspace-scripts-button").filter({ visible: true });
    await expect(runner).toBeVisible();
    const diffBox = (await counter.boundingBox())!;
    const runnerBox = (await runner.boundingBox())!;
    expect(diffBox.x + diffBox.width).toBeLessThanOrEqual(runnerBox.x);

    await counter.click();
    await expect(
      page.getByTestId("changes-header").filter({ visible: true }).first(),
    ).toBeVisible();

    await writeFile(path.join(workspace.repoPath, "counter.txt"), "before\n");
    await workspace.client.checkoutRefresh(workspace.repoPath);
    await expect(counter).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

// Geometry drift, owner review (2026-10-25): at 1400px the counter measured 26px tall beside a
// 44px scripts button (expected the button's height plus its 2px frame). No commit explains it.
test.fixme("diff counter matches the scripts button height", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const workspace = await openChangedWorkspace(page);
  try {
    await ensureExplorerSidebar(page);
    const counter = page.getByTestId("workspace-diff-counter").filter({ visible: true });
    const runner = page.getByTestId("workspace-scripts-button").filter({ visible: true });
    await expect(counter).toBeVisible({ timeout: 30_000 });
    const diffBox = (await counter.boundingBox())!;
    const runnerBox = (await runner.boundingBox())!;
    // The runner trigger sits inside its frame's two 1px borders.
    expect(diffBox.height).toBe(runnerBox.height + 2);
    expect(diffBox.y).toBe(runnerBox.y - 1);
  } finally {
    await workspace.cleanup();
  }
});

// Product regression, reported to Builds on 2026-10-25: since the toolbar consolidation
// (195e1c044) phones show no diff counter, so a phone has no diff summary in the workspace header.
test.fixme("diff counter stays reachable on phones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const workspace = await openChangedWorkspace(page);
  try {
    const counter = page.getByTestId("workspace-diff-counter").filter({ visible: true });
    await expect(counter).toBeVisible({ timeout: 30_000 });
    expect((await counter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } finally {
    await workspace.cleanup();
  }
});
