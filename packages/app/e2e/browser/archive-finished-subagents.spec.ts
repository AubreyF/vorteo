import type { Page } from "@playwright/test";
import { z } from "zod";
import { loadProtocolSchemas } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { test, expect } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  archiveFinishedSubagents,
  expectArchiveFinishedInProgress,
  expectArchiveFinishedRetry,
  expectManagedSubagentArchived,
  expectManagedSubagentUnarchived,
  expectSubagentRowGone,
  expectSubagentRowVisible,
  holdManagedSubagentArchiveRequest,
  openSubagentsTrack,
  rejectNextManagedSubagentArchiveRequest,
  seedParentWithSubagent,
} from "../support/helpers/subagents";

test.describe("Archive finished subagents", () => {
  let workspace: SeededWorkspace;

  test.beforeAll(async () => {
    workspace = await seedWorkspace({ repoPrefix: "archive-finished-subagents-" });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  test("distinguishes provider children and explains dismissal", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Mixed delegation supervisor",
      childTitle: "Managed review worker",
    });
    await provideCompletedChild(page, agents.parent.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    const workers = page.getByTestId("subagents-group-paseo");
    const providers = page.getByTestId("subagents-group-provider");
    await page.setViewportSize({ width: 1280, height: 844 });
    // The group headings are Subagents and System sub-agents since 0d18398e7.
    await expect(workers).toContainText("Subagents");
    await expect(workers).toContainText("Managed review worker");
    const workerToggle = workers.getByTestId("subagents-group-paseo-toggle");
    const providerToggle = providers.getByTestId("subagents-group-provider-toggle");
    await workerToggle.click();
    await expect(workers.getByTestId(`subagents-track-row-${agents.child.id}`)).toHaveCount(0);
    await expect(providers.getByTestId("subagents-track-row-provider-review")).toBeVisible();
    await workerToggle.click();
    await providerToggle.click();
    await expect(workers.getByTestId(`subagents-track-row-${agents.child.id}`)).toBeVisible();
    await expect(providers.getByTestId("subagents-track-row-provider-review")).toHaveCount(0);
    await providerToggle.click();
    await expect(providers).toContainText("System sub-agents");
    // Status and model moved into the row's tooltip in 2cf5e0cbb; it opens on hover on desktop.
    await providers.getByTestId("subagents-track-row-provider-review").hover();
    const providerTooltip = page.getByRole("tooltip").filter({ hasText: "Provider review child" });
    await expect(providerTooltip).toContainText("Completed", { timeout: 10_000 });
    await expect(providerTooltip).toContainText("Model not reported");
    await page.mouse.move(1, 1);
    await expect(providerTooltip).toHaveCount(0);
    await expect(
      providers.getByRole("button", { name: "Dismiss Provider review child", exact: true }),
    ).toBeVisible();
    const explanation = page.getByTestId("subagents-group-provider-info");
    await explanation.hover();
    await expect(page.getByText(/Created inside the coding provider’s session/)).toBeVisible();
    await expect(
      page.getByText(/Dismiss hides finished children until this app reloads/),
    ).toBeVisible();
    await page.mouse.click(1, 1);
    await expect(page.getByText(/Created inside the coding provider’s session/)).toBeHidden();
    await providers.getByTestId("subagents-track-archive-finished").click();
    await expect(providers).toHaveCount(0);
    await expectManagedSubagentUnarchived(workspace, agents.child.id);
    await expect(workers).toBeVisible();
  });

  test("clearing Vorteo children leaves system children visible", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Independent cleanup supervisor",
      childTitle: "Finished Vorteo child",
    });
    await provideCompletedChild(page, agents.parent.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    const workers = page.getByTestId("subagents-group-paseo");
    const providers = page.getByTestId("subagents-group-provider");
    await expect(providers).toBeVisible();
    await workers.getByTestId("subagents-track-archive-finished").click();
    await expectManagedSubagentArchived(workspace, agents.child.id);
    await expect(workers).toHaveCount(0);
    await expect(providers.getByTestId("subagents-track-row-provider-review")).toBeVisible();
  });

  test("archives a finished managed child from the track", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Archive parent",
      childTitle: "Finished child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );

    const archiveGate = await holdManagedSubagentArchiveRequest(page, agents.child.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await archiveFinishedSubagents(page);
    await archiveGate.waitForRequest();

    await expectSubagentRowGone(page, agents.child.id);
    await expectArchiveFinishedInProgress(page, 0, 1);
    await expectManagedSubagentUnarchived(workspace, agents.child.id);
    archiveGate.release();
    await expectManagedSubagentArchived(workspace, agents.child.id);
  });

  test("restores a failed child and retries the archive", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Retry parent",
      childTitle: "Retry child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );

    const rejection = await rejectNextManagedSubagentArchiveRequest(page, agents.child.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await archiveFinishedSubagents(page);
    await rejection.waitForRejection();

    await expectSubagentRowVisible(page, agents.child.id);
    await expectArchiveFinishedRetry(page);
    await archiveFinishedSubagents(page);

    await expectSubagentRowGone(page, agents.child.id);
    await expectManagedSubagentArchived(workspace, agents.child.id);
  });
});

async function provideCompletedChild(page: Page, parentAgentId: string): Promise<void> {
  // A deterministic provider descriptor exercises presentation and dismissal,
  // without making a paid provider call or testing provider discovery here.
  const { ProviderSubagentListResponseMessageSchema } = await loadProtocolSchemas();
  const envelopeSchema = z.object({
    type: z.literal("session"),
    message: ProviderSubagentListResponseMessageSchema,
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const envelope = envelopeSchema.safeParse(JSON.parse(String(message)));
      if (envelope.success && envelope.data.message.payload.parentAgentId === parentAgentId) {
        const response = envelope.data;
        response.message.payload.error = null;
        response.message.payload.subagents = [
          {
            id: "provider-review",
            parentAgentId: parentAgentId,
            provider: "codex",
            title: "Provider review child",
            description: null,
            status: "completed",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1).toISOString(),
            toolCallId: null,
          },
        ];
        ws.send(JSON.stringify(response));
        return;
      }
      ws.send(message);
    });
  });
}
