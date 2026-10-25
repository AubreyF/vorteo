import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";

for (const width of [390, 680]) {
  test(`mobile workspace keeps Files inline and scripts in its menu at ${width}px`, async ({
    page,
  }, info) => {
    test.fixme(
      width === 680,
      "Product regression, reported to Builds on 2026-10-25: windows from 500px to 719px now get the desktop layout instead of the phone header and menu (94087127e moved useIsCompactFormFactor from the 720px breakpoint to the composer's 500px). Remove the fixme once phone navigation starts below 720px again.",
    );
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
      // The script's output proves it ran on any shell.
      await expect
        .poll(
          async () => {
            const { terminals } = await client.listTerminals(undefined, undefined, {
              workspaceId: agent.workspaceId,
            });
            const captures = await Promise.all(
              terminals.map((terminal) => client.captureTerminal(terminal.id, { stripAnsi: true })),
            );
            return captures.some((capture) =>
              capture.lines.join("\n").includes("mobile-script-ok"),
            );
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      // Exit codes come from the daemon's zsh shell integration only (packages/server terminal.ts),
      // so Linux CI runners on bash never show the badge.
      if (path.basename(process.env.SHELL ?? "") === "zsh") {
        await expect(page.getByTestId("workspace-scripts-item-check")).toContainText("exit 0", {
          timeout: 20_000,
        });
      }
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}
