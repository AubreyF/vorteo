import { expect, type Page } from "@playwright/test";
import type { SharedProviderPreferences } from "@getpaseo/protocol/messages";
import { connectDaemonClient } from "./daemon-client-loader";

interface ProfileConfigClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getDaemonConfig(): Promise<{ config: { sharedProviderPreferences?: SharedProviderPreferences } }>;
  patchDaemonConfig(config: {
    sharedProviderPreferences: SharedProviderPreferences;
    expectedProviderPreferencesRevision: number | null;
  }): Promise<unknown>;
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

/** Mock catalog ids are the labels in kebab case, so tests may name a model either way. */
function mockModelId(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Adds a shared mock profile that pins `model`, leaving the host's other profiles in place.
 * The default profile fixture restores the host's profiles after the test.
 */
async function ensureMockModelProfile(model: string): Promise<string> {
  const modelId = mockModelId(model);
  const profileId = `e2e-mock-${modelId}`;
  const client = await connectDaemonClient<ProfileConfigClient>({
    clientIdPrefix: "model-profile-e2e",
  });
  try {
    const current = (await client.getDaemonConfig()).config.sharedProviderPreferences;
    const providers: SharedProviderPreferences["providers"] = { ...current?.providers };
    const mock = providers.mock ?? {
      defaults: {},
      workflows: [],
      preferredModels: [],
      preferredThinkingOptions: [],
      defaultWorkflowId: null,
    };
    if (!mock.workflows.some((workflow) => workflow.id === profileId)) {
      providers.mock = {
        ...mock,
        workflows: [
          ...mock.workflows,
          { id: profileId, name: `E2E ${modelId}`, provider: "mock", model: modelId },
        ],
      };
      await client.patchDaemonConfig({
        sharedProviderPreferences: {
          version: 1,
          revision: current?.revision ?? 0,
          providers,
          legacyProfiles: current?.legacyProfiles ?? {},
        },
        expectedProviderPreferencesRevision: current?.revision ?? null,
      });
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  return profileId;
}

/**
 * The composer has no model control: a profile decides the model. Choosing a model means
 * choosing a profile that pins it, inline on New workspace or from the toolbar's profile
 * selector in a workspace draft.
 */
export async function chooseMockModelProfile(page: Page, model: string): Promise<void> {
  await chooseProfile(page, { provider: "mock", profileId: await ensureMockModelProfile(model) });
}

/** Open the composer's Choose profile dialog, unless New workspace already shows it inline. */
export async function openProfilePicker(page: Page): Promise<void> {
  if (await page.getByTestId("new-workspace-profile-selector").isVisible()) return;
  await page.getByTestId("agent-preset-selector").filter({ visible: true }).first().click();
  await expect(page.getByTestId("account-preset-menu").filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Choose a shared profile by id, from the inline picker or the Choose profile dialog. Shared
 * profiles name a provider type; `account` picks which enabled provider of that type runs it and
 * defaults to the type's own provider.
 */
export async function chooseProfile(
  page: Page,
  input: { provider: string; profileId: string; account?: string },
): Promise<void> {
  const row = page.getByTestId(`preset-row-shared-profile/${input.provider}/${input.profileId}`);
  await openProfilePicker(page);
  // Profile rows list under their account, so reveal that account's profiles first.
  const account = page.getByTestId(`preset-account-${input.account ?? input.provider}`);
  await expect(account.filter({ visible: true })).toBeVisible({ timeout: 30_000 });
  await account.click();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const useProfile = page.getByTestId("preset-use-profile");
  if (await useProfile.isVisible()) {
    await useProfile.click();
    await expect(useProfile).toHaveCount(0);
    return;
  }
  // Inline rows apply on click; the selected row gets an accent border.
  await expect(row).not.toHaveCSS("border-top-color", TRANSPARENT);
}

/**
 * Since 70639f19a, applying a profile to a running thread first offers to switch it in place.
 * Recreating it as a new task goes through that sheet's new task choice to the handoff modal.
 */
export async function chooseNewTaskForProfile(page: Page): Promise<void> {
  await page.getByTestId("profile-switch-new-task").click();
  await expect(page.getByTestId("preset-handoff-modal")).toBeVisible({ timeout: 30_000 });
}
