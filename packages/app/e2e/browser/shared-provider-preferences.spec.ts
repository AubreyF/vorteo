import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SharedProviderPreferences } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import {
  submitDraftAgent,
  waitForDraftComposer,
} from "../support/helpers/command-center-agent-controls";
import { setVortonMode } from "../support/helpers/app";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("shared choices survive account changes, reject unavailable reasoning, and protect an open editor", async ({
  page,
}) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "shared-preferences" });
  const previous = (await client.getDaemonConfig()).config;
  const initial = previous.sharedProviderPreferences!;
  const preferences: SharedProviderPreferences = {
    version: 1,
    revision: initial.revision,
    defaultProvider: "codex",
    legacyProfiles: {},
    providers: {
      codex: {
        defaults: { model: "shared-model", modeId: "full-access", thinkingOptionId: "medium" },
        preferredModels: ["shared-model"],
        preferredThinkingOptions: ["medium", "high"],
        workflows: [{ id: "review", name: "Review", provider: "codex" }],
        defaultWorkflowId: "review",
      },
    },
  };
  const fullModel = {
    id: "shared-model",
    label: "Shared model",
    thinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  };
  await client.patchDaemonConfig({
    providers: {
      "shared-one": {
        extends: "codex",
        label: "Shared account one",
        enabled: true,
        command: ["node"],
        models: [fullModel],
      },
      "shared-two": {
        extends: "codex",
        label: "Shared account two",
        enabled: true,
        command: ["node"],
        models: [fullModel],
      },
      "shared-limited": {
        extends: "codex",
        label: "Shared limited account",
        enabled: true,
        command: ["node"],
        models: [{ ...fullModel, thinkingOptions: [fullModel.thinkingOptions[0]] }],
      },
    },
    sharedProviderPreferences: preferences,
    expectedProviderPreferencesRevision: initial.revision,
  });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "shared-preferences-",
    title: "Shared preferences",
  });
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await setVortonMode(page, true);
    await page.getByTestId("agent-preset-selector").click();
    await page.getByTestId("preset-account-shared-one").click();
    await page.getByTestId("shared-thinking-trigger").click();
    await page.getByText("High", { exact: true }).last().click();
    await page.getByTestId("preset-account-shared-two").click();
    await expect(page.getByTestId("shared-thinking-trigger")).toContainText("High");
    await page.getByTestId("preset-account-shared-limited").click();
    await expect(
      page.getByText(
        "This reasoning level is unavailable on this account. Select another level or account.",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("preset-use-profile")).toBeDisabled();
    await page.getByTestId("preset-account-shared-one").click();
    await page.getByTestId("preset-manage-profiles").click();
    await expect(page.getByTestId("shared-provider-settings")).toContainText(
      "Applies to all codex accounts",
    );
    await page.getByRole("button", { name: /^Preferred reasoning/ }).click();
    await page.getByRole("button", { name: "High", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await client.getDaemonConfig()).config.sharedProviderPreferences!.providers.codex
            .preferredThinkingOptions,
      )
      .toEqual(["medium"]);
    await page.getByRole("button", { name: "Edit defaults", exact: true }).click();
    await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible();
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
    await client.patchDaemonConfig({
      sharedProviderPreferences: {
        ...current,
        providers: {
          ...current.providers,
          codex: {
            ...current.providers.codex,
            defaults: { ...current.providers.codex.defaults, thinkingOptionId: "high" },
          },
        },
      },
      expectedProviderPreferencesRevision: current.revision,
    });
    await page.getByTestId("agent-profile-save-button").click();
    await expect(
      page.getByText(
        "Provider preferences changed on another device. Reload the editor before saving.",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("agent-profile-submit-error")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("agent-profile-save-button")).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: test.info().outputPath("shared-preferences-conflict.png") });
    await page.getByTestId("agent-profile-cancel-button").click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("agent-preset-selector").click();
    await page.getByTestId("preset-account-shared-two").click();
    await expect(page.getByTestId("shared-thinking-trigger")).toContainText("High");
    await expect(page.getByTestId("preset-accounts-back")).toBeVisible();
    await waitForSettledPosition(page.getByTestId("preset-choices-shared-two"));
    await expect
      .poll(async () =>
        Math.abs((await page.getByTestId("preset-choices-shared-two").boundingBox())!.x),
      )
      .toBeLessThan(1);
    await expect(page.getByTestId("preset-use-profile")).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("shared-preferences-mobile.png") });
    await page.getByText("Saved profile permissions", { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("preset-use-profile")).toBeInViewport();
    await page.getByTestId("preset-accounts-back").click();
    await page.mouse.click(195, 150);
    await expect(page.getByTestId("preset-manage-profiles")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("sidebar-footer-overflow")).toBeVisible();
    await setVortonMode(page, false);
    await expect(page.getByTestId("agent-preset-selector")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
    await client.patchDaemonConfig({
      sharedProviderPreferences: initial,
      expectedProviderPreferencesRevision: current.revision,
      removeProviders: ["shared-one", "shared-two", "shared-limited"],
    });
    await client.close();
  }
});

test("shared launch freezes permissions and recreation uses the updated workflow", async ({
  page,
}) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "shared-launch" });
  const previous = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
  const preferences: SharedProviderPreferences = {
    version: 1,
    revision: previous.revision,
    legacyProfiles: {},
    providers: {
      mock: {
        defaults: { model: "five-minute-stream", modeId: "load-test" },
        preferredModels: [],
        preferredThinkingOptions: ["medium", "high"],
        workflows: [{ id: "everyday", name: "Everyday", provider: "mock" }],
        defaultWorkflowId: "everyday",
      },
    },
  };
  await client.patchDaemonConfig({
    sharedProviderPreferences: preferences,
    expectedProviderPreferencesRevision: previous.revision,
  });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "shared-launch-",
    title: "Shared launch",
  });
  try {
    const config = {
      provider: "mock",
      cwd: workspace.cwd,
      profileId: "shared-workflow/mock/everyday",
      model: "five-minute-stream",
      thinkingOptionId: "high",
    };
    const agent = await client.createAgent({ config, workspaceId: workspace.workspaceId });
    expect(agent.currentModeId).toBe("load-test");
    expect(agent.thinkingOptionId).toBe("high");
    await expect(
      client.createAgent({
        config: { ...config, thinkingOptionId: "unavailable" },
        workspaceId: workspace.workspaceId,
      }),
    ).rejects.toThrow("not available");
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
    await client.patchDaemonConfig({
      sharedProviderPreferences: {
        ...current,
        providers: {
          mock: {
            ...current.providers.mock,
            defaults: { ...current.providers.mock.defaults, modeId: "approval-test" },
          },
        },
      },
      expectedProviderPreferencesRevision: current.revision,
    });
    expect((await client.fetchAgent(agent.id))!.agent.currentModeId).toBe("load-test");
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await expectComposerVisible(page);
    await setVortonMode(page, true);
    await expect(page.getByTestId("profile-permission-warning")).toContainText(
      "saved profile uses Approval Test",
    );
    await page.getByTestId("profile-permission-recreate").click();
    await expect(page.getByTestId("preset-handoff-modal")).toBeVisible();
    await page
      .getByTestId("preset-handoff-context")
      .fill("Continue with the updated shared permissions.");
    await page.getByTestId("preset-handoff-confirm").click();
    await expect(page.getByTestId("preset-handoff-modal")).toHaveCount(0);
    const successors = await client.fetchAgents({
      filter: { labels: { "paseo:continued-from": agent.id } },
    });
    expect(successors.entries).toHaveLength(1);
    expect(successors.entries[0].agent.currentModeId).toBe("approval-test");
    expect((await client.fetchAgent(agent.id))!.agent.currentModeId).toBe("load-test");
  } finally {
    await workspace.cleanup();
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
    await client.patchDaemonConfig({
      sharedProviderPreferences: previous,
      expectedProviderPreferencesRevision: current.revision,
    });
    await client.close();
  }
});

test("a new draft keeps the remembered account when another account owns the default workflow", async ({
  page,
}) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "draft-account" });
  const previous = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
  await client.patchDaemonConfig({
    sharedProviderPreferences: {
      version: 1,
      revision: previous.revision,
      defaultProvider: "codex",
      legacyProfiles: {},
      providers: {
        codex: {
          defaults: { model: "gpt-5.4-mini", modeId: "full-access" },
          preferredModels: [],
          preferredThinkingOptions: [],
          workflows: [{ id: "review", name: "Other account review", provider: "codex" }],
          defaultWorkflowId: "review",
        },
        mock: {
          defaults: { model: "e2e-fast-stream", modeId: "load-test" },
          preferredModels: [],
          preferredThinkingOptions: [],
          workflows: [{ id: "everyday", name: "Remembered account workflow", provider: "mock" }],
          defaultWorkflowId: "everyday",
        },
      },
    },
    expectedProviderPreferencesRevision: previous.revision,
  });
  const workspace = await seedWorkspace({ repoPrefix: "draft-account-" });
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:create-agent-preferences",
        JSON.stringify({
          vortonMode: true,
          provider: "mock",
          providerPreferences: { mock: { model: "e2e-fast-stream", mode: "load-test" } },
        }),
      );
    });
    await gotoWorkspace(page, workspace.workspaceId);
    await runWorkspaceActionFromCommandCenter(page, "New agent");
    await waitForDraftComposer(page);
    await expect(page.getByTestId("agent-preset-selector").filter({ visible: true })).toContainText(
      "Remembered account workflow",
    );
    await submitDraftAgent(page, "Launch with the remembered account workflow");
    await expect
      .poll(async () => {
        const agents = await client.fetchAgents({ scope: "active" });
        return agents.entries.find((entry) => entry.agent.workspaceId === workspace.workspaceId)
          ?.agent.provider;
      })
      .toBe("mock");
    await page.screenshot({ path: test.info().outputPath("draft-account-launch.png") });
  } finally {
    await workspace.cleanup();
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences!;
    await client.patchDaemonConfig({
      sharedProviderPreferences: previous,
      expectedProviderPreferencesRevision: current.revision,
    });
    await client.close();
  }
});
