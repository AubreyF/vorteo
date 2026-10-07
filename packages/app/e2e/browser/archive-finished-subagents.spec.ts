import type { Page } from "@playwright/test";
import { z } from "zod";
import { loadProtocolSchemas } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
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

  test("shows each worker's profile code and model on desktop and compact layouts", async ({
    page,
  }, info) => {
    const profiles = await seedAgentProfiles(
      [
        {
          id: "worker",
          name: "Worker Medium",
          nickname: "WM",
          provider: "mock",
          model: "ten-second-stream",
          thinkingOptionId: "medium",
          modeId: "load-test",
        },
      ],
      true,
    );
    try {
      const agents = await seedParentWithSubagent(workspace, {
        parentTitle: "Profile supervisor",
        childTitle: "Unprofiled child",
      });
      const child = await workspace.client.createAgent({
        provider: "mock",
        profileId: "shared-workflow/mock/worker",
        cwd: workspace.repoPath,
        workspaceId: agents.workspaceId,
        title: "Profiled review worker",
        labels: { [PARENT_AGENT_ID_LABEL]: agents.parent.id },
      });
      await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
      await openSubagentsTrack(page);
      const row = page.getByTestId(`subagents-track-row-${child.id}`);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(row).toContainText("WM · ten-second-stream · medium");
        await expect(row.getByTestId(`subagents-track-archive-${child.id}`)).toBeVisible();
        const screenshot = info.outputPath(`subagent-profile-${width}.png`);
        await row.screenshot({ path: screenshot });
        await info.attach(`subagent profile ${width}`, {
          path: screenshot,
          contentType: "image/png",
        });
      }
      page.once("dialog", (dialog) => {
        expect(dialog.message()).toContain("Archive subagent?");
        void dialog.accept();
      });
      await row.getByTestId(`subagents-track-archive-${child.id}`).click();
      await expectSubagentRowGone(page, child.id);
      await expectManagedSubagentArchived(workspace, child.id);
    } finally {
      await profiles.restore();
    }
  });

  test("distinguishes provider children and explains dismissal on desktop and compact layouts", async ({
    page,
  }, info) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Mixed delegation supervisor",
      childTitle: "Managed review worker",
    });
    await provideCompletedChild(page, agents.parent.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    const workers = page.getByTestId("subagents-group-paseo");
    const providers = page.getByTestId("subagents-group-provider");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(workers).toContainText("Vorteo workers (1)");
      await expect(workers).toContainText("Managed review worker");
      await expect(providers).toContainText("Provider subagents (1)");
      await expect(providers).toContainText("Completed");
      await expect(providers).toContainText("Model not reported");
      await expect(
        providers.getByRole("button", { name: "Dismiss Provider review child", exact: true }),
      ).toBeVisible();
      const explanation = page.getByTestId("subagents-group-provider-info");
      if (width === 1280) await explanation.hover();
      else await explanation.click();
      await expect(page.getByText(/Created inside the coding provider’s session/)).toBeVisible();
      await expect(
        page.getByText(/Dismiss hides finished children until this app reloads/),
      ).toBeVisible();
      await expect(page.getByRole("tooltip").filter({ hasText: "Created inside" })).toHaveCSS(
        "opacity",
        "1",
      );
      const explanationScreenshot = info.outputPath(`subagent-explanation-${width}.png`);
      await page.screenshot({ path: explanationScreenshot });
      await info.attach(`subagent explanation ${width}`, {
        path: explanationScreenshot,
        contentType: "image/png",
      });
      await page.mouse.click(1, 1);
      await expect(page.getByText(/Created inside the coding provider’s session/)).toBeHidden();
      const screenshot = info.outputPath(`subagent-ownership-${width}.png`);
      await page.screenshot({ path: screenshot });
      await info.attach(`subagent ownership ${width}`, {
        path: screenshot,
        contentType: "image/png",
      });
    }
    await providers
      .getByRole("button", { name: "Dismiss Provider review child", exact: true })
      .click();
    await expect(providers).toHaveCount(0);
    await expectManagedSubagentUnarchived(workspace, agents.child.id);
    await expect(workers).toBeVisible();
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
