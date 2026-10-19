import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";

for (const width of [390, 680]) {
  test(`mobile workspace keeps Files inline and scripts in its menu at ${width}px`, async ({
    page,
  }, info) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "mobile-files-",
      title: "Mobile workspace cards",
      initialPrompt: "emit 2 agent stream updates",
      repo: {
        paseoConfig: { scripts: { check: { type: "task", command: "echo mobile-script-ok" } } },
      },
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "mobile-cards" });
    try {
      await client.mutateMessageQueue(agent.agentId, {
        kind: "pause",
        paused: true,
        expectedRevision: 0,
        operationId: "pause-mobile",
      });
      await client.mutateMessageQueue(agent.agentId, {
        kind: "enqueue",
        operationId: "enqueue-mobile",
        messageId: "mobile-message",
        text: "Queued after Files",
        attachments: [],
      });
      await page.setViewportSize({ width, height: 1000 });
      await openAgentRoute(page, agent);
      const header = page.getByTestId("screen-header").filter({ visible: true });
      await expect(header.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
      await expect(header.getByTestId("workspace-header-menu-trigger")).toBeVisible();
      await expect(header.getByTestId("workspace-explorer-toggle")).toHaveCount(0);
      await expect(header.getByTestId("workspace-scripts-button")).toHaveCount(0);
      const files = page.getByTestId("supporting-card-files").filter({ visible: true });
      await files.scrollIntoViewIfNeeded();
      await expect(files).toBeVisible();
      const queue = page.getByTestId("shared-message-queue").filter({ visible: true });
      expect(
        await files.evaluate((node) => {
          const queueNode = document.querySelector('[data-testid="shared-message-queue"]');
          return Boolean(
            queueNode && node.compareDocumentPosition(queueNode) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      ).toBe(true);
      await files.getByTestId("supporting-card-files-toggle").click();
      await expect(files.getByTestId("file-explorer-tree-scroll")).toBeVisible();
      await expect(queue).toBeAttached();
      await page.screenshot({ path: info.outputPath("inline-files.png") });
      await header.getByTestId("workspace-header-menu-trigger").click();
      await expect(page.getByTestId("workspace-scripts-item-check")).toBeVisible();
      await page.getByTestId("workspace-scripts-start-check").click();
      await expect(page.getByTestId("workspace-scripts-item-check")).toContainText("0", {
        timeout: 20000,
      });
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}
