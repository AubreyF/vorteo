import { expect, test, type Page } from "../support/fixtures";
import path from "node:path";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { seedAgentProfiles, seedModelProvider } from "../support/helpers/agent-profiles";
import { gotoAppShell } from "../support/helpers/app";
import { captureWorkspaceAgentRequest } from "../support/helpers/creation";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { chooseProfile } from "../support/helpers/model-profile";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";
const MODELESS_PROVIDER = "modeless-profile-e2e";
const MODELESS_MODEL = "pi-profile-model";

async function seedPoisonedModelessPreference(page: Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, provider, model }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          provider,
          providerPreferences: {
            [provider]: { model, mode: "full-access" },
            mock: { model: "ten-second-stream", mode: "load-test" },
          },
        } satisfies FormPreferences),
      );
    },
    {
      preferencesKey: CREATE_AGENT_PREFERENCES_KEY,
      provider: MODELESS_PROVIDER,
      model: MODELESS_MODEL,
    },
  );
}

async function readProviderModePreference(page: Page, provider: string): Promise<unknown> {
  return page.evaluate(
    ({ preferencesKey, providerId }) => {
      const raw = localStorage.getItem(preferencesKey);
      if (!raw) return null;
      const preferences = JSON.parse(raw) as FormPreferences;
      return preferences.providerPreferences?.[providerId]?.mode ?? null;
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY, providerId: provider },
  );
}

// The composer's model picker went with the Paseo mode in 471d7f22a, so these journeys choose
// profiles on New workspace, and returning to Pi means choosing a Pi profile.
test.describe("Agent profiles repair modeless provider preferences", () => {
  test.describe.configure({ timeout: 240_000 });

  test("applying a profile heals a stale mode before returning to Pi", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "profile-modeless-preferences-" });
    const profiles = await seedAgentProfiles(
      [
        {
          id: "agent_profile_modeless_repair",
          name: "Approval work",
          provider: "mock",
          model: "one-minute-stream",
          modeId: "approval-test",
        },
        {
          id: "agent_profile_modeless_pi",
          name: "Pi work",
          provider: "pi",
          model: MODELESS_MODEL,
        },
      ],
      true,
    );
    const provider = await seedModelProvider({
      id: MODELESS_PROVIDER,
      label: "Pi profile test",
      extends: "pi",
      command: [process.execPath, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
      models: [
        {
          id: MODELESS_MODEL,
          label: "Pi profile model",
          description: "Modeless profile regression model",
        },
      ],
    });
    await seedPoisonedModelessPreference(page);
    const createAgentRecorder = await captureWorkspaceAgentRequest(page, { block: true });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

      await chooseProfile(page, { provider: "mock", profileId: "agent_profile_modeless_repair" });
      await expect
        .poll(() => readProviderModePreference(page, MODELESS_PROVIDER), { timeout: 10_000 })
        .toBeNull();
      await chooseProfile(page, {
        provider: "pi",
        account: MODELESS_PROVIDER,
        profileId: "agent_profile_modeless_pi",
      });

      await submitNewWorkspacePrompt(page, "Create a Pi agent after repairing preferences.");
      const createAgentRequest = await createAgentRecorder.waitForRequest();
      expect(createAgentRequest).toMatchObject({
        config: { provider: MODELESS_PROVIDER },
      });
      expect(createAgentRequest.config).not.toHaveProperty("modeId");
    } finally {
      await workspace.cleanup();
      await provider.restore();
      await profiles.restore();
    }
  });

  test("cross-provider profile features survive immediate workspace creation", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "profile-feature-transition-" });
    const featureProviderId = "profile-feature-e2e";
    const featureModelId = "claude-opus-5";
    const profiles = await seedAgentProfiles(
      [
        {
          id: "agent_profile_feature_transition",
          name: "Fast profile",
          provider: "claude",
          model: featureModelId,
          modeId: "bypassPermissions",
          featureValues: { fast_mode: true },
        },
      ],
      true,
    );
    const provider = await seedModelProvider({
      id: featureProviderId,
      label: "Profile feature test",
      models: [
        {
          id: featureModelId,
          label: "Profile feature model",
          description: "Cross-provider feature regression model",
        },
      ],
    });
    const createAgentRecorder = await captureWorkspaceAgentRequest(page, { block: true });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });

      await chooseProfile(page, {
        provider: "claude",
        account: featureProviderId,
        profileId: "agent_profile_feature_transition",
      });
      await submitNewWorkspacePrompt(page, "Create an agent with profile features.");

      const createAgentRequest = await createAgentRecorder.waitForRequest();
      expect(createAgentRequest).toMatchObject({
        config: {
          provider: featureProviderId,
          featureValues: { fast_mode: true },
        },
      });
    } finally {
      await workspace.cleanup();
      await provider.restore();
      await profiles.restore();
    }
  });
});
