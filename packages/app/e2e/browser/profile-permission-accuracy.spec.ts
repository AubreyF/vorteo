import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { expectWorkspaceAgentConfiguration } from "../support/helpers/command-center-agent-controls";

test("profile edits warn legacy chats and recreation uses the updated permissions", async ({
  page,
}) => {
  const profile = {
    id: "permission-profile",
    name: "Supervisor profile",
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
  };
  const seed = await seedAgentProfiles([profile]);
  const seeded = await seedWorkspace({ repoPrefix: "permission-accuracy-" });
  const agent = await seeded.client.createAgent({
    provider: "mock",
    cwd: seeded.repoPath,
    workspaceId: seeded.workspaceId,
    profileId: profile.id,
  });
  const workspace = { ...seeded, agentId: agent.id, cwd: seeded.repoPath };
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);

    await expect(page.getByTestId("preset-permission-trigger")).toHaveCount(0);
    await expect(page.getByTestId("profile-permission-warning")).toHaveCount(0);
    const update = await seedAgentProfiles([{ ...profile, modeId: "approval-test" }]);
    try {
      const warning = page.getByTestId("profile-permission-warning");
      await expect(warning).toContainText("This chat uses Load Test");
      await expect(warning).toContainText("saved profile uses Approval Test");
      await expectWorkspaceAgentConfiguration(workspace, {
        id: agent.id,
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(warning).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("legacy-permission-warning.png") });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByTestId("profile-permission-recreate").click();
      await expect(page.getByTestId("preset-handoff-modal")).toBeVisible();
      await page
        .getByTestId("preset-handoff-context")
        .fill("Continue the existing task with the updated profile permissions.");
      await page.getByTestId("preset-handoff-confirm").click();
      await expect(page.getByTestId("preset-handoff-modal")).toHaveCount(0);
      await expect(warning).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await seeded.client.fetchAgents()).entries.filter(
              (entry) => entry.agent.id !== agent.id,
            ).length,
        )
        .toBe(1);
      const successor = (await seeded.client.fetchAgents()).entries.find(
        (entry) => entry.agent.id !== agent.id,
      );
      expect(successor).toBeDefined();
      await expectWorkspaceAgentConfiguration(workspace, {
        id: successor!.agent.id,
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "approval-test",
      });
      await expectWorkspaceAgentConfiguration(workspace, {
        id: agent.id,
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
      });
      await expect(
        page.getByRole("button", { name: "Select agent mode (Approval test)" }),
      ).toBeVisible();
    } finally {
      await update.restore();
    }
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});
