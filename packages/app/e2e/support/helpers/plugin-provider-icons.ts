import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import { expect, test as base, type Page } from "../fixtures";
import { gotoAppShell, openSettings } from "./app";
import { seedAgentProfiles } from "./agent-profiles";
import { openAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient, openGlobalNewWorkspaceComposer } from "./new-workspace";
import { copyPluginExample } from "./plugin-fixture";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { openProfilePicker } from "./model-profile";
import { openSettingsHostSection } from "./settings";

// The composer's model picker went with the Paseo mode in 471d7f22a, so the provider icon now
// shows on the profile picker's Account card. An account lists only with a profile to run.
const PROVIDER = "direct-example";
const PROFILE = { id: "agent_profile_plugin_icon", name: "Plugin icon", provider: PROVIDER };
const WIDE = { width: 1400, height: 950 };
const COMPACT = { width: 390, height: 844 };

async function readIconPaths(page: Page, pluginDirectory: string): Promise<string[]> {
  const svg = await readFile(path.join(pluginDirectory, "icon.svg"), "utf8");
  return page.evaluate(
    (source) =>
      Array.from(
        new DOMParser().parseFromString(source, "image/svg+xml").querySelectorAll("path"),
        (element) => element.getAttribute("d") ?? "",
      ),
    svg,
  );
}

function readIconDrawings(icons: SVGElement[]): string[][] {
  return icons.map((icon) =>
    Array.from(icon.querySelectorAll("path"), (element) => element.getAttribute("d") ?? ""),
  );
}

async function expectProviderIcon(surface: Locator, paths: string[]): Promise<void> {
  await expect(surface).toBeVisible();
  // Provider icons are decorative SVGs without accessible names. Compare the
  // plugin asset's drawing, allowing surface-specific size and theme colours.
  await expect
    .poll(() => surface.locator("svg").evaluateAll(readIconDrawings))
    .toContainEqual(paths);
}

function accountCard(page: Page): Locator {
  return page.getByTestId(`preset-account-${PROVIDER}`).filter({ visible: true }).first();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

interface ProviderIconJourney {
  page: Page;
  testInfo: TestInfo;
  iconPaths: string[];
  workspace: SeededWorkspace;
}

export const test = base.extend<{ providerIcons: ProviderIconJourney }>({
  providerIcons: async ({ page }, provide, testInfo) => {
    const client = await connectNewWorkspaceDaemonClient();
    try {
      const previous = await client.getDaemonConfig();
      const plugin = await copyPluginExample("provider-direct");
      try {
        try {
          await client.patchDaemonConfig({ pluginsEnabled: true });
          await client.installDirectoryPlugin(plugin.directory);
          const workspace = await seedWorkspace({ repoPrefix: "plugin-provider-icons-" });
          const profiles = await seedAgentProfiles([{ ...PROFILE, model: "example-1" }], true);
          try {
            await page.setViewportSize(WIDE);
            await gotoAppShell(page);
            const iconPaths = await readIconPaths(page, plugin.directory);
            await provide({ page, testInfo, iconPaths, workspace });
          } finally {
            await profiles.restore();
            await workspace.cleanup();
          }
        } finally {
          try {
            await client.removePlugin("provider-direct-example");
          } finally {
            await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
          }
        }
      } finally {
        await plugin.cleanup();
      }
    } finally {
      await client.close();
    }
  },
});

export async function verifyProviderSettings({
  page,
  iconPaths,
  testInfo,
}: ProviderIconJourney): Promise<void> {
  await test.step("provider settings render the registered icon", async () => {
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "providers");
    await expectProviderIcon(
      page.getByRole("button", { name: "Direct provider example provider details", exact: true }),
      iconPaths,
    );
    await capture(page, testInfo, "provider-settings");
    await page.getByTestId("settings-back-to-workspace").click();
  });
}

export async function verifyNewWorkspaceModelIcon({
  page,
  iconPaths,
  testInfo,
}: ProviderIconJourney): Promise<void> {
  await test.step("new workspace shows the icon on the provider's account", async () => {
    await openGlobalNewWorkspaceComposer(page);
    await expectProviderIcon(accountCard(page), iconPaths);
    await capture(page, testInfo, "new-workspace-account");
  });
}

export async function verifyCompactModelIcon({
  page,
  iconPaths,
  testInfo,
}: ProviderIconJourney): Promise<void> {
  await test.step("compact New workspace preserves the same provider icon", async () => {
    await page.setViewportSize(COMPACT);
    // Compact layouts collapse each step to a summary row; expand Account to list its cards.
    await page.getByRole("button", { name: /^2\. Account/ }).click();
    await expectProviderIcon(accountCard(page), iconPaths);
    await capture(page, testInfo, "compact-account");
  });
}

export async function verifyExistingAgentModelIcon({
  page,
  iconPaths,
  testInfo,
  workspace,
}: ProviderIconJourney): Promise<void> {
  await test.step("an existing agent's profile picker uses the same icon", async () => {
    const agent = await workspace.client.createAgent({
      provider: PROVIDER,
      model: "example-1",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Plugin icon agent",
    });
    await page.setViewportSize(WIDE);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await openProfilePicker(page);
    await expectProviderIcon(accountCard(page), iconPaths);
    await capture(page, testInfo, "agent-profile-picker-account");
  });
}
