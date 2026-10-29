import type { Dialog } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  installAcpCatalogProvider,
  openAddProviderArea,
  openSettingsHost,
  openSettingsHostSection,
} from "../support/helpers/settings";

const CUSTOM_PROVIDER = {
  id: "junie",
  name: "Junie",
} as const;

interface ProviderRemovalDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  patchDaemonConfig(config: { removeProviders?: string[] }): Promise<unknown>;
  getProvidersSnapshot(): Promise<{
    entries: Array<{ provider: string; source?: "builtin" | "custom" }>;
  }>;
}

async function removeCustomProvider(client: ProviderRemovalDaemonClient): Promise<void> {
  await client.patchDaemonConfig({ removeProviders: [CUSTOM_PROVIDER.id] });
}

async function expectProviderSource(
  client: ProviderRemovalDaemonClient,
  source: "custom" | undefined,
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await client.getProvidersSnapshot();
      return snapshot.entries.find((entry) => entry.provider === CUSTOM_PROVIDER.id)?.source;
    })
    .toBe(source);
}

async function clickRemoveProviderAndAcceptWarning(page: Page): Promise<Dialog> {
  // The confirmation blocks the page until accepted, so accept it in the handler. On a busy page
  // it can arrive after the click returns, so wait for it rather than checking right away (CI run
  // 40290226521).
  const shown = new Promise<Dialog>((resolve) => {
    page.once("dialog", (dialog) => {
      void dialog.accept();
      resolve(dialog);
    });
  });
  await page.getByTestId(`provider-remove-${CUSTOM_PROVIDER.id}`).click();
  const warning = await Promise.race([
    shown,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error("Expected a provider removal confirmation dialog, but none was shown.")),
        10_000,
      ),
    ),
  ]);
  expect(warning.message()).toContain(`Remove ${CUSTOM_PROVIDER.name}?`);
  // The confirmation explains what happens to the connection's credentials.
  expect(warning.message()).toContain("Delete this connection?");
  return warning;
}

test.describe("provider removal", () => {
  test("removes a custom provider from Settings", async ({ page }) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<ProviderRemovalDaemonClient>({
      clientIdPrefix: "provider-removal-e2e",
    });

    try {
      await removeCustomProvider(client);

      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");

      // Built-in providers offer no Delete; custom ones show it on their row since 471d7f22a.
      await expect(page.getByTestId("provider-remove-claude")).toHaveCount(0);
      await openAddProviderArea(page);
      await installAcpCatalogProvider(page, CUSTOM_PROVIDER.name);
      await expectProviderInstalledInSettings(page, CUSTOM_PROVIDER.name);
      await expectProviderSource(client, "custom");

      await expect(page.getByTestId(`provider-remove-${CUSTOM_PROVIDER.id}`)).toBeVisible();
      await clickRemoveProviderAndAcceptWarning(page);

      await expect(
        page.getByRole("button", {
          name: `${CUSTOM_PROVIDER.name} provider details`,
          exact: true,
        }),
      ).toHaveCount(0);
      await expectProviderSource(client, undefined);
    } finally {
      await removeCustomProvider(client).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
});
