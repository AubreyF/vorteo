import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

test("diff counter moves between the toolbar and composer with Vorteo mode", async ({ page }) => {
  const workspace = await seedWorkspace({
    repoPrefix: "toolbar-diff-",
    repo: {
      withRemote: true,
      files: [{ path: "counter.txt", content: "before\n" }],
      paseoConfig: { scripts: { check: { type: "task", command: "echo checked" } } },
    },
  });
  try {
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
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect
      .poll(async () => {
        const result = await workspace.client.fetchWorkspaces();
        return result.entries.find((entry) => entry.id === workspace.workspaceId)?.diffStat;
      })
      .toEqual({ additions: 2, deletions: 1 });
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });

    const counter = page.getByTestId("workspace-diff-counter");
    const floater = page.getByTestId("composer-diff-stat-pill");
    await expect(counter).toBeVisible({ timeout: 30000 });
    await expect(counter).toContainText("+2");
    await expect(counter).toContainText("-1");
    await expect(floater).toHaveCount(0);
    for (const width of [1400, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(counter).toBeVisible();
      const runner = page.getByTestId("workspace-scripts-button");
      await expect(runner).toBeVisible();
      const diffBox = await counter.boundingBox();
      const runnerBox = await runner.boundingBox();
      expect(diffBox).not.toBeNull();
      expect(runnerBox).not.toBeNull();
      expect(diffBox!.x + diffBox!.width).toBeLessThanOrEqual(runnerBox!.x);
      if (width === 390) expect(diffBox!.height).toBeGreaterThanOrEqual(44);
      if (width === 1400) {
        // The runner trigger sits inside its frame's two 1px borders.
        expect(diffBox!.height).toBe(runnerBox!.height + 2);
        expect(diffBox!.y).toBe(runnerBox!.y - 1);
      }
    }
    await counter.click();
    await expect(
      page.getByTestId("changes-header").filter({ visible: true }).first(),
    ).toBeVisible();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.evaluate(() => {
      localStorage.setItem(
        "@paseo:e2e-disable-default-seed-once",
        localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
      );
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: false }),
      );
    });
    await page.reload();
    await expect(counter).toHaveCount(0);
    await expect(floater).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem(
        "@paseo:e2e-disable-default-seed-once",
        localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
      );
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
      );
    });
    await page.reload();
    await expect(counter).toBeVisible();
    await expect(floater).toHaveCount(0);
    await writeFile(path.join(workspace.repoPath, "counter.txt"), "before\n");
    await workspace.client.checkoutRefresh(workspace.repoPath);
    await expect(counter).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
