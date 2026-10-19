import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { fillComposerDraft, expectComposerVisible } from "../support/helpers/composer";

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "touch" : "mouse", () => {
    test.use({ hasTouch });
    test("narrow Queue and Send remain clickable with fixed actions and Command emphasis", async ({
      page,
    }) => {
      const agent = await seedMockAgentWorkspace({
        repoPrefix: "narrow-submit-",
        title: "Narrow submit",
        model: "thirty-minute-stream",
        initialPrompt: "Keep running for composer checks",
      });
      const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "narrow-submit" });
      try {
        await client.mutateMessageQueue(agent.agentId, {
          kind: "pause",
          paused: true,
          expectedRevision: 0,
          operationId: "pause-narrow",
        });
        await page.setViewportSize({ width: 1400, height: 1000 });
        await openAgentRoute(page, agent);
        await expectComposerVisible(page);
        await page.setViewportSize({ width: 390, height: 1000 });
        const input = page.getByRole("textbox", { name: "Message agent..." }).first();
        const queue = page.getByTestId("mobile-queue-message");
        const send = page.getByRole("button", { name: "Send message", exact: true });
        const draft = "A long draft to expose any overlapping text hit target. ".repeat(25);
        await fillComposerDraft(page, draft);
        await expect(queue).toBeEnabled();
        const primaryColor = await send.evaluate((node) => getComputedStyle(node).backgroundColor);
        const secondaryColor = await queue.evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        );
        expect(primaryColor).not.toBe(secondaryColor);
        await page.keyboard.down("Meta");
        await expect(queue).toHaveCSS("background-color", primaryColor);
        await expect(send).toHaveCSS("background-color", secondaryColor);
        await page.keyboard.up("Meta");
        if (hasTouch) await queue.tap();
        else await queue.click();
        await expect(input).toHaveValue("");
        await expect
          .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items.length)
          .toBe(1);
        await fillComposerDraft(page, "Keyboard queued message");
        await input.press("Meta+Enter");
        await expect(input).toHaveValue("");
        await expect
          .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items.length)
          .toBe(2);
        await fillComposerDraft(page, "Send immediately from the lower button");
        if (hasTouch) await send.tap();
        else await send.click();
        await expect(input).toHaveValue("");
        expect((await client.readMessageQueue(agent.agentId)).snapshot?.items.length).toBe(2);
      } finally {
        await client.close();
        await agent.cleanup();
      }
    });
  });
}
