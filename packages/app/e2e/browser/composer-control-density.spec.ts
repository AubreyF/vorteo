import { openAgentRoute } from "../support/helpers/mock-agent";
import { test, expect } from "../support/fixtures";
import { openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import {
  expectNoCollapsedComposerToolbarFrame,
  recordComposerToolbarFrames,
} from "../support/helpers/composer-control-density";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const SETTLE_MS = 1_000;

async function seedSettledMockAgent(workspace: SeededWorkspace, title: string) {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
  });
  await workspace.client.waitForAgentUpsert(
    agent.id,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  return { id: agent.id, title, cwd: workspace.repoPath, workspaceId: workspace.workspaceId };
}

function visibleAgentTab(page: import("@playwright/test").Page, agentId: string) {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

test.describe("Composer control density across tab switches", () => {
  test.describe.configure({ timeout: 180_000 });

  test("switching between agent tabs never paints a collapsed composer toolbar", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-density-agents-" });
    try {
      const first = await seedSettledMockAgent(workspace, "First chat");
      const second = await seedSettledMockAgent(workspace, "Second chat");
      await openWorkspaceWithAgents(page, [first, second]);

      await recordComposerToolbarFrames(page);
      await visibleAgentTab(page, first.id).click();
      await page.waitForTimeout(SETTLE_MS);
      await visibleAgentTab(page, second.id).click();
      await page.waitForTimeout(SETTLE_MS);

      await expectNoCollapsedComposerToolbarFrame(page);
    } finally {
      await workspace.cleanup();
    }
  });

  // Retired 2026-10-25: the draft-tab case measured the draft composer's mode control, which went
  // with the Paseo mode in 471d7f22a; drafts now carry a profile instead.
});

test.describe("Touch composer corner spacing", () => {
  test.use({ hasTouch: true });
  test("tablet composer fits its controls and matches bottom and side insets", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-corners-" });
    try {
      const agent = await seedSettledMockAgent(workspace, "Composer corners");
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.id });
      for (const width of [1024, 1133, 1600]) {
        await page.setViewportSize({ width, height: 744 });
        const surface = page.getByTestId("message-input-surface").filter({ visible: true });
        const attach = surface.getByTestId("message-input-attach-button");
        await expect(attach).toBeVisible();
        await expect(async () => {
          const frame = (await surface.boundingBox())!;
          const button = (await attach.boundingBox())!;
          expect(frame.height).toBeLessThanOrEqual(118);
          expect(button.height).toBeGreaterThanOrEqual(44);
          expect(frame.y + frame.height - button.y - button.height).toBeCloseTo(
            button.x - frame.x,
            0,
          );
        }).toPass();
      }
    } finally {
      await workspace.cleanup();
    }
  });
});
