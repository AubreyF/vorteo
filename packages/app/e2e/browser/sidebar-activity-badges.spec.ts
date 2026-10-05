import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

test.use({ vortonMode: true });

async function openShowPreferences(page: Page): Promise<void> {
  await page.getByTestId("sidebar-footer-overflow").click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Settings",
    "Usage",
    "Add project",
    "New workspace",
    "View preferences",
    "Help and support",
  ]);
  await page.getByTestId("sidebar-display-preferences-action").click();
  await page.getByTestId("sidebar-display-show").click();
}

test("activity badges can be hidden, stay hidden after reload, and return when enabled", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-badges-",
    title: "Badge preferences",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "sidebar-badges" });
  try {
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      operationId: "pause",
      expectedRevision: 0,
    });
    await client.mutateMessageQueue(agent.agentId, {
      kind: "enqueue",
      operationId: "add",
      messageId: "badge-check",
      text: "Queued badge check",
      attachments: [],
    });
    await openAgentRoute(page, agent);
    const badge = page.getByTestId(/^workspace-queue-count-/);
    await expect(badge).toHaveText("Q1");
    await openShowPreferences(page);
    const toggle = page.getByTestId("sidebar-row-item-activityBadges");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(badge).toHaveCount(0);
    await page.evaluate(() => {
      localStorage.setItem(
        "@paseo:e2e-disable-default-seed-once",
        localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
      );
    });
    await page.reload();
    await openShowPreferences(page);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(badge).toHaveCount(0);
    await toggle.click();
    await expect(badge).toHaveText("Q1");
  } finally {
    await client.close();
    await agent.cleanup();
  }
});
