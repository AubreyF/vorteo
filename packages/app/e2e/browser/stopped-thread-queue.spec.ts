import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { seedRunningMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { expectComposerVisible, fillComposerDraft } from "../support/helpers/composer";

// This spec handles the "Set up worktree scripts" notice itself.
test.use({ dismissWorktreeSetupCallout: false });

for (const width of [1280, 390]) {
  test(`queues without restarting a stopped thread at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const agent = await seedRunningMockAgentWorkspace({
      repoPrefix: "stopped-queue-",
      title: "Stopped thread queue",
      model: "thirty-minute-stream",
      initialPrompt: "Run until explicitly stopped",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "stopped-queue" });
    try {
      await page.setViewportSize({ width, height: 900 });
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      // This disposable project has no setup scripts; its notice covers Stop on desktop.
      await page.getByTestId(/^worktree-setup-callout-.*-dismiss$/).click();
      await page.getByRole("button", { name: "Stop agent", exact: true }).click();
      await expect
        .poll(async () => (await client.fetchAgent(agent.agentId))?.agent.status)
        .toBe("idle");
      // Since 614c0e44f Stop leaves queue delivery alone, so a stopped thread holds queued
      // messages only while its queue is explicitly paused.
      const { snapshot } = await client.readMessageQueue(agent.agentId);
      await client.mutateMessageQueue(agent.agentId, {
        kind: "pause",
        paused: true,
        operationId: "pause",
        expectedRevision: snapshot!.revision,
      });
      await expect
        .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.paused)
        .toBe(true);
      const input = page.getByRole("textbox", { name: "Message agent..." }).first();
      await fillComposerDraft(page, "Wait for my return");
      await input.press("Meta+Enter");
      await expect(input).toHaveValue("");
      await expect
        .poll(async () =>
          (await client.readMessageQueue(agent.agentId)).snapshot?.items.map((item) => item.text),
        )
        .toEqual(["Wait for my return"]);
      await fillComposerDraft(page, "Keep this queued too");
      await page.keyboard.down("Meta");
      const queue =
        width === 390
          ? page.getByTestId("mobile-queue-message")
          : page.getByRole("button", { name: "Queue message", exact: true });
      await expect(queue).toBeEnabled();
      await queue.click();
      await page.keyboard.up("Meta");
      await expect(input).toHaveValue("");
      await expect
        .poll(async () =>
          (await client.readMessageQueue(agent.agentId)).snapshot?.items.map((item) => item.text),
        )
        .toEqual(["Wait for my return", "Keep this queued too"]);
      await page.reload();
      await expectComposerVisible(page);
      await expect(page.getByTestId("shared-message-queue")).toContainText("Wait for my return");
      expect((await client.fetchAgent(agent.agentId))?.agent.status).toBe("idle");
      expect((await client.readMessageQueue(agent.agentId)).snapshot?.paused).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("stopped-queue.png") });
      await fillComposerDraft(page, "Resume by explicit Send");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect
        .poll(async () => (await client.fetchAgent(agent.agentId))?.agent.status)
        .toBe("running");
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}
