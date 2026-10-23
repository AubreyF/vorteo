import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { expectComposerVisible, fillComposerDraft } from "../support/helpers/composer";

// This spec handles the "Set up worktree scripts" notice itself.
test.use({ dismissWorktreeSetupCallout: false });

for (const width of [1133, 1600, 390]) {
  test(`queue remains reachable and progress stays in its row at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "queue-inline-",
      title: "Queue placement",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "queue-inline" });
    try {
      const snapshot = (await client.readMessageQueue(agent.agentId)).snapshot!;
      await client.mutateMessageQueue(agent.agentId, {
        kind: "pause",
        paused: true,
        operationId: "pause",
        expectedRevision: snapshot.revision,
      });
      await client.mutateMessageQueue(agent.agentId, {
        kind: "enqueue",
        messageId: "first",
        operationId: "first",
        text: "First queued message",
        attachments: [],
      });
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      const dismiss = page.getByTestId(/^worktree-setup-callout-.*-dismiss$/);
      if (await dismiss.isVisible()) await dismiss.click();
      const card = page.getByTestId("shared-message-queue");
      const timeline = page.getByTestId("agent-chat-scroll");
      if (width > 700) {
        const dock = page.getByTestId("workspace-supporting-cards");
        const toggle = page.getByTestId("workspace-explorer-toggle");
        if (await dock.isVisible()) await toggle.click();
        await expect(timeline.getByTestId("shared-message-queue")).toBeVisible();
        await expect(timeline.getByTestId("agent-task-progress-card")).toHaveCount(0);
        await expect(timeline.getByTestId("agent-journal-card")).toHaveCount(0);
        const row = timeline.getByTestId("queue-message-first");
        await row.getByRole("button", { name: "Edit queued message", exact: true }).click();
        const editor = row.getByRole("textbox", { name: "Edit queued message" });
        await expect(editor).toHaveValue("First queued message");
        await editor.fill("Edited in the conversation");
        await toggle.click();
        await expect(dock).toBeVisible();
        await expect(editor).toHaveValue("Edited in the conversation");
        await expect(dock.getByTestId("shared-message-queue")).toHaveCount(0);
        await expect(timeline.getByTestId("shared-message-queue")).toBeVisible();
        await toggle.click();
        await expect(editor).toHaveValue("Edited in the conversation");
        await row.getByRole("button", { name: "Save", exact: true }).click();
        await expect(row).toContainText("Edited in the conversation");
        await expect(timeline.getByTestId("shared-message-queue")).toBeVisible();
      }
      await expect(timeline.getByTestId("shared-message-queue")).toBeVisible();
      await expect(card).toHaveCount(1);
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        const original = WebSocket.prototype.send;
        const held: (() => void)[] = [];
        WebSocket.prototype.send = function (data) {
          if (
            typeof data === "string" &&
            JSON.parse(data).message?.type === "agent.queue.mutate.request"
          )
            held.push(() => original.call(this, data));
          else original.call(this, data);
        };
        Object.assign(window, { releaseQueue: () => held.splice(0).forEach((send) => send()) });
      });
      await fillComposerDraft(page, "Saving this queued message");
      await page.getByRole("textbox", { name: "Message agent..." }).first().press("Meta+Enter");
      const saving = card
        .getByTestId(/^queue-message-/)
        .filter({ hasText: "Saving this queued message" });
      await expect(saving.getByTestId("queue-local-indicator")).toBeVisible();
      await page.evaluate(() => (window as unknown as { releaseQueue(): void }).releaseQueue());
      await expect
        .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items.length)
        .toBe(2);
      await expect(saving.getByTestId("queue-local-indicator")).toHaveCount(0);
      const first = page.getByTestId("queue-message-first");
      const before = (await first.boundingBox())!;
      const countBefore = await first.getByRole("button").count();
      const send = first.getByRole("button", { name: "Send queued message now", exact: true });
      await expect(send).toBeEnabled();
      await send.click();
      await expect(first.getByTestId("queue-send-progress")).toBeVisible();
      expect((await first.boundingBox())!.height).toBeCloseTo(before.height, 0);
      await expect(first.getByRole("button")).toHaveCount(countBefore);
      await expect(card).not.toContainText("Sending...");
      await expect(page.getByTestId("message-queue-header-status")).toHaveText("Paused");
      await page.screenshot({ path: info.outputPath(`queue-inline-${width}.png`) });
    } finally {
      await page.close();
      await client.close();
      await agent.cleanup();
    }
  });
}
