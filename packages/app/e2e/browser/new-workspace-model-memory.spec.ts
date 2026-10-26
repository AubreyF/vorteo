import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { seedAgentProfiles, seedModelProvider } from "../support/helpers/agent-profiles";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  openGlobalNewWorkspaceComposer,
  submitNewWorkspaceEmpty,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

import {
  startWithoutRememberedModel,
  expectCreatedModelAgents,
  expectRememberedProfile,
} from "../support/helpers/model-memory";
import { chooseProfile } from "../support/helpers/model-profile";

const PROVIDER = "model-memory-diagnostic";
const MODEL = "pi-profile-model";
const LABEL = "Pi profile model";
// The composer's model picker went with the Paseo mode in 471d7f22a; New workspace now remembers
// the chosen profile, which pins the model.
const PROFILE = { provider: "pi", account: PROVIDER, profileId: "agent_profile_model_memory" };

async function expectProviderStatus(client: DaemonClient, cwd: string | undefined, status: string) {
  await expect
    .poll(
      async () =>
        (await client.getProvidersSnapshot(cwd ? { cwd } : undefined)).entries.find(
          (entry) => entry.provider === PROVIDER,
        )?.status,
      { timeout: 30_000 },
    )
    .toBe(status);
}

async function prepareCatalogState(
  client: DaemonClient,
  executable: string,
  cwd: string,
  hostStatus: "ready" | "unavailable",
) {
  await expectProviderStatus(client, undefined, "ready");
  await expectProviderStatus(client, cwd, "ready");
  await rename(executable, `${executable}.parked`);
  await client.refreshProvidersSnapshot({ providers: [PROVIDER] });
  await expectProviderStatus(client, undefined, "unavailable");
  await rename(`${executable}.parked`, executable);
  if (hostStatus === "ready") await client.refreshProvidersSnapshot({ providers: [PROVIDER] });
  await client.refreshProvidersSnapshot({ cwd, providers: [PROVIDER] });
  await expectProviderStatus(client, cwd, "ready");
  await expectProviderStatus(client, undefined, hostStatus);
}

for (const hostStatus of ["ready", "unavailable"] as const) {
  test(`remembers the manually selected model after two creations with a ${hostStatus} host catalog and ready project catalog`, async ({
    page,
  }) => {
    // Possible product regression, reported to Builds on 2026-10-25: since 471d7f22a the profile
    // picker reads only the host catalog, so while it reports the provider unavailable its
    // profiles cannot be chosen, even with a ready project catalog. Remove once resolved.
    test.fixme(
      hostStatus === "unavailable",
      "Profiles hidden while the host catalog is unavailable",
    );
    test.setTimeout(150_000);
    const workspace = await seedWorkspace({ repoPrefix: "model-memory-scope-" });
    const binDir = await mkdtemp(path.join(tmpdir(), "paseo-model-memory-bin-"));
    const executable = path.join(binDir, "provider-node");
    await symlink(process.execPath, executable);
    const provider = await seedModelProvider({
      id: PROVIDER,
      label: "Model memory diagnostic",
      extends: "pi",
      command: [executable, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
      models: [{ id: MODEL, label: LABEL, description: "Remembered selection diagnostic" }],
    });
    const profiles = await seedAgentProfiles(
      [{ id: PROFILE.profileId, name: "Pi memory", provider: "pi", model: MODEL }],
      true,
    );
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "model-memory" });
    try {
      await prepareCatalogState(client, executable, workspace.repoPath, hostStatus);

      await startWithoutRememberedModel(page);
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await chooseProfile(page, PROFILE);
      for (const count of [1, 2]) {
        await test.step(`create workspace ${count} and return`, async () => {
          await submitNewWorkspacePrompt(page, "Remember this profile on the next workspace");
          await expect(page).toHaveURL(/\/workspace\//);
          await expectCreatedModelAgents(page, client, PROVIDER, MODEL, count);
          await openGlobalNewWorkspaceComposer(page);
          await expectRememberedProfile(page, PROFILE);
        });
      }
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//);
      await openGlobalNewWorkspaceComposer(page);
      await expectRememberedProfile(page, PROFILE);
    } finally {
      await profiles.restore();
      await client.close();
      await provider.restore();
      await workspace.cleanup();
      await rm(binDir, { recursive: true, force: true });
    }
  });
}
