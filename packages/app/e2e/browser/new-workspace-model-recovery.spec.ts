import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { seedAgentProfiles, seedModelProvider } from "../support/helpers/agent-profiles";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoWorkspace } from "../support/helpers/launcher";
import { openGlobalNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { expectRememberedProfile } from "../support/helpers/model-memory";
import { chooseProfile } from "../support/helpers/model-profile";

const PROVIDER = "remembered-model-recovery";
const MODEL = "remembered-model";
const LABEL = "Remembered model";
// The composer's model picker went with the Paseo mode in 471d7f22a; New workspace now remembers
// the chosen profile, which pins the model.
const PROFILE = { provider: "claude", account: PROVIDER, profileId: "agent_profile_recovery" };

async function setProviderAvailability(client: DaemonClient, cwd: string, available: boolean) {
  await client.patchDaemonConfig({
    providers: {
      [PROVIDER]: {
        command: available
          ? [process.execPath, path.resolve("e2e/fixtures/catalog-claude.cjs")]
          : ["/missing-paseo-diagnostic-provider"],
      },
    },
  });
  for (const scope of [undefined, cwd]) {
    await expect
      .poll(
        async () => {
          const snapshot = await client.getProvidersSnapshot(scope ? { cwd: scope } : undefined);
          return snapshot.entries.find((entry) => entry.provider === PROVIDER)?.status;
        },
        { timeout: 30_000 },
      )
      .toBe(available ? "ready" : "unavailable");
  }
}

test("restores the remembered profile when a provider recovers after New workspace opens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "model-recovery-" });
  const provider = await seedModelProvider({
    id: PROVIDER,
    label: "Remembered provider",
    models: [{ id: MODEL, label: LABEL, description: "Model restoration diagnostic" }],
  });
  const profiles = await seedAgentProfiles(
    [{ id: PROFILE.profileId, name: "Recovery", provider: "claude", model: MODEL }],
    true,
  );
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "model-recovery" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await openGlobalNewWorkspaceComposer(page);
    await chooseProfile(page, PROFILE);

    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await setProviderAvailability(client, workspace.repoPath, false);
    await openGlobalNewWorkspaceComposer(page);
    await expect(page.getByTestId("new-workspace-profile-selector")).toBeVisible();

    await setProviderAvailability(client, workspace.repoPath, true);
    // The picker keeps showing the account it fell back to, so reopen the remembered account.
    await page.getByTestId(`preset-account-${PROVIDER}`).click();
    await expectRememberedProfile(page, PROFILE);
  } finally {
    await profiles.restore();
    await client.close();
    await provider.restore();
    await workspace.cleanup();
  }
});
