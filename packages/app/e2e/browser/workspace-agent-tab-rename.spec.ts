import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../support/fixtures";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";
import { createMockIdleAgent, expectWorkspaceTabVisible } from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { getServerId } from "../support/helpers/server-id";

async function openAgentInWorkspace(page: Page, agent: { id: string; workspaceId: string }) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, agent.id);
}

async function fetchAgentTitle(client: SeedDaemonClient, agentId: string): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

test.describe("Workspace agent tab rename", () => {
  test("right-click rename persists the agent title and updates the tab label", async ({
    page,
  }, info) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1800, height: 1000 });
    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-rename-" });

    try {
      const initialTitle = `agent-rename-${randomUUID().slice(0, 8)}`;
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.workspaceDirectory,
        workspaceId: workspace.workspaceId,
        title: initialTitle,
      });

      await openAgentInWorkspace(page, agent);

      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
      await expect(tab).toContainText(initialTitle, { timeout: 15_000 });

      await tab.click({ button: "right" });
      await expect(page.getByTestId(`workspace-tab-context-agent_${agent.id}`)).toBeVisible({
        timeout: 10_000,
      });
      const renameItem = page.getByTestId(`workspace-tab-context-agent_${agent.id}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-agent-${agent.id}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);

      const renamed = "Prepare Atlas release notes and review the complete navigation experience";
      await input.fill(renamed);
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText(renamed, { timeout: 15_000 });
      await expect.poll(() => fetchAgentTitle(workspace.client, agent.id)).toBe(renamed);
      await expect.poll(async () => (await tab.boundingBox())!.width).toBe(420);
      expect((await tab.boundingBox())!.height).toBe(44);
      const pane = page.getByTestId("workspace-pane-main");
      const tabs = (await pane.getByTestId("workspace-tabs-row").boundingBox())!;
      const scroller = pane.getByTestId("agent-chat-scroll");
      expect((await scroller.boundingBox())!.y).toBeCloseTo(tabs.y + tabs.height, 1);
      await expect(scroller).toHaveCSS("mask-image", /linear-gradient/);
      for (let i = 0; i < 6; i++) {
        const additional = await createMockIdleAgent(workspace.client, {
          cwd: workspace.workspaceDirectory,
          workspaceId: workspace.workspaceId,
          title: `Additional navigation review ${i + 1}`,
        });
        await openAgentInWorkspace(page, additional);
      }
      await expect.poll(async () => (await tab.boundingBox())!.width).toBeLessThan(420);
      expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(120);
      await page.mouse.move(900, 800);
      await expect(tab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(tab).toHaveCSS("box-shadow", "none");
      await tab.click();
      await page.mouse.move(900, 800);
      await expect(tab).not.toHaveCSS("box-shadow", "none");
      await page.screenshot({ path: info.outputPath("floating-tabs.png"), fullPage: true });
    } finally {
      await workspace.cleanup();
    }
  });
});
