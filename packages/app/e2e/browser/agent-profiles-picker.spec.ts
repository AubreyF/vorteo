import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { buildHostAgentDetailRoute } from "../../src/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { expectWorkspaceAgentConfiguration } from "../support/helpers/command-center-agent-controls";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { chooseProfile, openProfilePicker } from "../support/helpers/model-profile";

const PROFILE = {
  id: "agent_profile_e2e_ui_work",
  name: "UI work",
  icon: "🎨",
  provider: "mock",
  model: "one-minute-stream",
  modeId: "approval-test",
  notes: "Use for UI work.",
};

// The composer's model picker went with the Paseo mode in 471d7f22a: a running agent's composer
// offers only Choose profile, and the profile carries the model. Retired with it: the pinned
// profile rows inside the model picker, the composer naming the model, and the model row's
// separate create-profile action, which has no equivalent in the profile picker.
test.describe("Agent profiles in the profile picker", () => {
  // These journeys own the host's profile list, including its empty state.
  test.use({ defaultMockProfile: false });

  // Product regression, reported to Builds on 2026-10-25: with no profiles the picker lists no
  // accounts, and Manage profiles does nothing without an account (471d7f22a). Remove the fixme
  // once an empty host can reach profile settings from the picker.
  test.fixme("an empty host still exposes agent profile settings from the picker", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([], true);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-empty-",
      title: "Agent profiles empty",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await openProfilePicker(page);
      await expect(page.locator('[data-testid^="preset-row-"]')).toHaveCount(0);
      await page.getByTestId("preset-manage-profiles").click();
      await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("choosing a profile applies its model and mode to the running agent", async ({ page }) => {
    const seed = await seedAgentProfiles([PROFILE], true);
    // A live agent is one provider's process, so the profile has to name that
    // same provider or the picker will not offer it at all.
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-picker-",
      title: "Agent profiles picker",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await chooseProfile(page, { provider: "mock", profileId: PROFILE.id });
      // A running thread switches profile only after confirming in the switch sheet.
      await page.getByTestId("profile-switch-confirm").click();
      await expect(page.getByTestId("profile-switch-sheet")).toHaveCount(0, { timeout: 30_000 });
      await expectWorkspaceAgentConfiguration(workspace, {
        id: workspace.agentId,
        provider: "mock",
        model: "one-minute-stream",
        modeId: "approval-test",
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });
});

test("an unavailable account can recover in place, with a visible failure and retry", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const home = await mkdtemp(path.join(tmpdir(), "provider-recovery-"));
  const cwd = path.join(home, "project");
  const configDir = path.join(home, "original-account");
  const projectId = `prj_${randomUUID()}`;
  const workspaceId = `wks_${randomUUID()}`;
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const serverId = `srv_recovery_${randomUUID()}`;
  const provider = "claude-retired";
  const timestamp = new Date().toISOString();
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(home, "projects"), { recursive: true });
  await mkdir(path.join(home, "agents", "recovery"), { recursive: true });
  await writeFile(
    path.join(home, "projects", "projects.json"),
    JSON.stringify([
      {
        projectId,
        rootPath: cwd,
        kind: "non_git",
        displayName: "Recovery",
        customName: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      },
    ]),
  );
  await writeFile(
    path.join(home, "projects", "workspaces.json"),
    JSON.stringify([
      {
        workspaceId,
        projectId,
        cwd,
        kind: "directory",
        displayName: "Original workspace",
        title: null,
        branch: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      },
    ]),
  );
  await writeFile(
    path.join(home, "agents", "recovery", `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider,
      cwd,
      workspaceId,
      title: "Recover this thread",
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      lastStatus: "closed",
      config: null,
      persistence: { provider, sessionId, metadata: { cwd } },
    }),
  );
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      version: 1,
      agents: {
        providers: {
          [provider]: {
            extends: "claude",
            label: "Retired account",
            enabled: false,
            env: { CLAUDE_CONFIG_DIR: configDir },
          },
        },
      },
    }),
  );
  const daemon = await startIsolatedHostDaemon(serverId, { paseoHome: home });
  const seed = await seedAgentProfiles([PROFILE], true, daemon.port);
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "recovery",
    port: daemon.port,
  });
  try {
    await client.refreshProvidersSnapshot({ providers: ["mock"] });
    expect(
      (await client.getProvidersSnapshot()).entries.find((entry) => entry.provider === "mock"),
    ).toMatchObject({ enabled: true, status: "ready" });
    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${daemon.port}`,
      nowIso: timestamp,
    });
    await page.addInitScript(
      (seededHost) => localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost])),
      host,
    );
    await page.goto(buildHostAgentDetailRoute(serverId, agentId, workspaceId));
    await expect(page.getByTestId("agent-provider-recovery")).toBeVisible({ timeout: 60_000 });
    for (const width of [1280, 402]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.getByTestId("agent-provider-recovery")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`recovery-${width}.png`) });
    }
    await openProfilePicker(page);
    await page.getByTestId("preset-section-account").click();
    await page.getByTestId("preset-account-mock").click();
    await page.getByTestId(`preset-row-shared-profile/mock/${PROFILE.id}`).click();
    await page.getByTestId("preset-use-profile").click();
    await expect(page.getByTestId("profile-switch-new-task")).toHaveCount(0);
    await page.getByTestId("profile-switch-confirm").click();
    await expect(page.getByTestId("profile-switch-error")).toContainText(
      "transcript could not be read",
    );
    await expect(page.getByTestId("profile-switch-confirm")).toBeEnabled();
    // A real local Claude transcript becomes readable; no Claude turn or account login is used.
    const transcriptDir = path.join(
      configDir,
      "projects",
      (await realpath(cwd)).replace(/[^a-zA-Z0-9]/g, "-"),
    );
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        sessionId,
        cwd,
        timestamp,
        message: { role: "user", content: "Keep the approved recovery plan" },
      }) + "\n",
    );
    await page.getByTestId("profile-switch-confirm").click();
    await expect(page.getByTestId("profile-switch-sheet")).toHaveCount(0, { timeout: 30_000 });
    await expectComposerVisible(page);
    await expect(page.getByText("Keep the approved recovery plan", { exact: true })).toBeVisible();
    expect((await client.fetchAgent(agentId))?.agent).toMatchObject({
      id: agentId,
      provider: "mock",
      workspaceId,
      title: "Recover this thread",
    });
    await page.reload();
    await expectComposerVisible(page);
    await expect(page.getByText("Keep the approved recovery plan", { exact: true })).toBeVisible();
  } finally {
    await seed.restore();
    await client.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
