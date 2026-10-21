import { expectAgentTabActive } from "../support/helpers/launcher";
import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

test("truncated card values reveal non-interactive details without changing row actions", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1900, height: 1100 });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "truncated-values-",
    title: "Tooltip checks",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "truncated-values" });
  const title =
    "A complete task title with enough detail to be truncated in the narrow supporting card";
  const message =
    "A queued message with important instructions that must remain readable even when the row truncates its contents. ".repeat(
      3,
    );
  const childTitle =
    "A subagent with a long descriptive title that should be readable without opening its thread";
  try {
    await client.mutateAgentChecklist(agent.agentId, {
      operation: "create",
      id: "long",
      text: title,
      description: "Relevant task context remains available here.",
    });
    await client.mutateAgentChecklist(agent.agentId, {
      operation: "create",
      id: "short",
      text: "Short task",
    });
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      expectedRevision: 0,
      operationId: "pause",
    });
    await client.mutateMessageQueue(agent.agentId, {
      kind: "enqueue",
      operationId: "enqueue",
      messageId: "long-message",
      text: message,
      attachments: [],
    });
    const child = await agent.client.createAgent({
      provider: "mock",
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      title: childTitle,
      modeId: "load-test",
      model: "e2e-fast-stream",
      labels: { [PARENT_AGENT_ID_LABEL]: agent.agentId },
    });
    await openAgentRoute(page, agent);
    const explorer = page.getByTestId("workspace-explorer-toggle").filter({ visible: true });
    if ((await explorer.getAttribute("aria-expanded")) === "false") await explorer.click();
    const tooltip = page.getByRole("tooltip");
    const task = page.getByTestId("checklist-row-long").getByText(title, { exact: true });
    await task.hover();
    await expect(tooltip).toContainText(title);
    await expect(tooltip).toContainText("Relevant task context");
    expect(await tooltip.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
    await page.screenshot({ path: info.outputPath("task-tooltip.png") });
    await page.mouse.move(700, 20);
    await expect(tooltip).toBeHidden();
    await page.getByTestId("checklist-row-short").getByText("Short task", { exact: true }).hover();
    await page.waitForTimeout(350);
    await expect(tooltip).toBeHidden();
    await page.getByText(message, { exact: true }).hover();
    await expect(tooltip).toContainText(message.trim());
    await page.mouse.move(700, 20);
    const childLabel = page.getByTestId(`subagents-track-label-${child.id}`);
    await childLabel.hover();
    await expect(tooltip).toContainText(childTitle);
    await childLabel.click();
    await expectAgentTabActive(page, child.id);
    await expect(tooltip).toBeHidden();
    await openAgentRoute(page, agent);
    await page.setViewportSize({ width: 390, height: 900 });
    // On a phone, the first tap on a subagent shows its details and the second opens it.
    const mobileChild = page.getByTestId(`subagents-track-label-${child.id}`);
    await mobileChild.scrollIntoViewIfNeeded();
    await mobileChild.click();
    await expect(tooltip).toContainText(childTitle);
    await mobileChild.click();
    // Phones have no tab strip: the child thread replaces the parent and the tooltip closes.
    await expect(mobileChild).toBeHidden();
    await expect(tooltip).toBeHidden();
    await openAgentRoute(page, agent);
    const mobileTask = page.getByTestId("checklist-row-long");
    await mobileTask.scrollIntoViewIfNeeded();
    await mobileTask.getByText(title, { exact: true }).click();
    await expect(tooltip).toBeHidden();
    await mobileTask.getByRole("button", { name: `Details for ${title}`, exact: true }).click();
    await expect(page.getByText("Task details", { exact: true })).toBeVisible();
  } finally {
    await client.close();
    await agent.cleanup();
  }
});
