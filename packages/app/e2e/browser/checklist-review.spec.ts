import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

for (const width of [1400, 390]) {
  test(`Review stays incomplete across reload at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "checklist-review-",
      title: "Review state",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "checklist-review" });
    try {
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "create",
        id: "approval",
        text: "Approve installation",
        description: "Waiting for your approval.",
      });
      await openAgentRoute(page, agent);
      const row = page.getByTestId("checklist-row-approval");
      await row.getByRole("button", { name: "Details for Approve installation" }).click();
      await page
        .getByTestId("checklist-editor")
        .getByRole("button", { name: "Review", exact: true })
        .click();
      await page.getByTestId("checklist-save").click();
      await expect(row.getByText("Review", { exact: true })).toBeVisible();
      await expect(row.getByTestId("task-running-spinner")).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 1");
      expect((await client.getAgentChecklist(agent.agentId))[0]).toMatchObject({
        status: "review",
        completed: false,
      });
      await page.reload();
      await expect(row.getByText("Review", { exact: true })).toBeVisible();
      await expect(row.getByText("Blocked", { exact: true })).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 1");
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`review-${width}.png`) });
      await row.getByRole("checkbox", { name: "Complete Approve installation" }).click();
      await expect(row.getByText("Review", { exact: true })).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("1 / 1");
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}
