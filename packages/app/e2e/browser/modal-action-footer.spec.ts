import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";

// This spec handles the "Set up worktree scripts" notice itself.
test.use({ dismissWorktreeSetupCallout: false });

for (const width of [1440, 390]) {
  test(`long modal keeps its actions visible at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 600 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "modal-footer-",
      title: "Modal actions",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "modal-footer" });
    try {
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "create",
        id: "edited",
        text: "Edit this task",
      });
      for (let index = 0; index < 24; index++) {
        await client.mutateAgentChecklist(agent.agentId, {
          operation: "create",
          id: `prerequisite-${index}`,
          text: `Prerequisite ${index + 1}`,
        });
      }
      await openAgentRoute(page, agent);
      if (width > 600) await ensureExplorerSidebar(page);
      await page.getByTestId(/^worktree-setup-callout-.*-dismiss$/).click();
      await page.getByRole("button", { name: "Details for Edit this task", exact: true }).click();
      const footer = page.getByTestId("checklist-modal-footer");
      const scroll = page.getByTestId("checklist-modal-scroll");
      const save = page.getByTestId("checklist-save");
      await waitForSettledPosition(footer);
      await expect(footer.getByRole("button", { name: "Delete task", exact: true })).toBeVisible();
      await expect(footer.getByRole("button", { name: "Close", exact: true })).toBeVisible();
      await expect(save).toBeVisible();
      const initial = (await footer.boundingBox())!;
      expect(initial.y).toBeGreaterThan(0);
      expect(initial.y + initial.height).toBeLessThanOrEqual(601);
      expect(await scroll.evaluate((node) => node.scrollTop)).toBe(0);
      await page.getByTestId("checklist-title").fill("Saved without chasing a button");
      const distance = await scroll.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        return node.scrollTop;
      });
      expect(distance).toBeGreaterThan(200);
      await expect.poll(async () => (await footer.boundingBox())!.y).toBeCloseTo(initial.y, 0);
      await expect(save).toBeInViewport();
      const hit = await save.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      });
      expect(hit).toBe(true);
      await page.screenshot({ path: info.outputPath(`fixed-footer-${width}.png`) });
      await save.click();
      await expect(page.getByTestId("checklist-editor")).not.toBeAttached();
      expect(
        (await client.getAgentChecklist(agent.agentId)).find((task) => task.id === "edited")?.text,
      ).toBe("Saved without chasing a button");
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}
