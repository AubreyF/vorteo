import { test, expect } from "../support/fixtures";
import {
  buildHostWorkspaceRoute,
  buildOpenProjectRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  closeCompactSettings,
  openSettingsSection,
  expectSettingsHeader,
  openAddHostFlow,
  selectHostConnectionType,
  toggleHostAdvanced,
  openCompactSettings,
  expectCompactSettingsList,
  expectSettingsSidebarVisible,
  expectSettingsSidebarHidden,
  expectSettingsSidebarSections,
  goBackInSettings,
  expectSettingsBackButton,
  clickSettingsBackToWorkspace,
  verifyLegacyHostSettingsRedirect,
  openCompactSettingsHost,
  expectAddHostMethodOptions,
  fillDirectHostUri,
  expectDirectHostFormValues,
  expectDirectHostSslEnabled,
  expectDirectHostUriValue,
  expectDirectHostUriHidden,
  expectDiagnosticsContent,
  expectAboutContent,
  expectGeneralContent,
  expectAppearanceContent,
  seedSavedSettingsHosts,
  openSettingsHostSection,
  removeCurrentHostFromSettings,
} from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { expectAppRoute } from "../support/helpers/route-assertions";

async function openWorkspace(
  page: import("@playwright/test").Page,
  workspace: { workspaceId: string },
) {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
  await expect(page.getByTestId("menu-button")).toBeVisible();
}

test.describe("Settings sidebar navigation", () => {
  test("clicking a sidebar section updates the URL and renders the section", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await openSettingsSection(page, "diagnostics");
    await expectSettingsHeader(page, "Diagnostics");
    await expectDiagnosticsContent(page);

    await openSettingsSection(page, "general");
    await expectSettingsHeader(page, "General");
    await expectAboutContent(page);
    await expectGeneralContent(page);

    await openSettingsSection(page, "appearance");
    await expectSettingsHeader(page, "Appearance");
    await expectAppearanceContent(page);

    const back = page.getByTestId("settings-back-to-workspace");
    await page.mouse.move(0, 0);
    await expect(back).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(back).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await back.hover();
    await expect(back).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: test.info().outputPath("settings-back-hover.png") });
    await clickSettingsBackToWorkspace(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("/h/[serverId]/settings redirects to the host connections section", async ({ page }) => {
    await gotoAppShell(page);
    await verifyLegacyHostSettingsRedirect(page);
  });

  test("direct connection advanced URI round-trips SSL and password into the form", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openAddHostFlow(page);
    await expectAddHostMethodOptions(page);
    await selectHostConnectionType(page, "direct");

    await toggleHostAdvanced(page);
    await fillDirectHostUri(page, "tcp://example.paseo.test:7443?ssl=true&password=shared-secret");
    await toggleHostAdvanced(page);

    await expectDirectHostFormValues(page, {
      host: "example.paseo.test",
      port: "7443",
      password: "shared-secret",
    });
    await expectDirectHostSslEnabled(page);
    await expectDirectHostUriHidden(page);

    await toggleHostAdvanced(page);
    await expectDirectHostUriValue(
      page,
      "tcp://example.paseo.test:7443?ssl=true&password=shared-secret",
    );
    await toggleHostAdvanced(page);
    await expectDirectHostUriHidden(page);
  });

  test("Escape lets settings dropdowns and modals close before leaving settings", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await test.step("a dropdown owns Escape", async () => {
      await openSettingsSection(page, "appearance");
      await page.getByLabel(/Theme:/).click();
      await expect(page.getByRole("menuitem", { name: "System", exact: true })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByRole("menuitem", { name: "System", exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings(\/|$)/);
    });

    await test.step("a modal owns Escape", async () => {
      await openAddHostFlow(page);
      await expect(page.getByRole("dialog").filter({ hasText: "Add connection" })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByRole("dialog").filter({ hasText: "Add connection" })).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings(\/|$)/);
    });

    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opens compact app and host details and returns through the settings list", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expectSettingsSidebarSections(page, ["general", "diagnostics"]);
    await expectCompactSettingsList(page);

    await test.step("open app details and return to the list", async () => {
      await openSettingsSection(page, "diagnostics");
      await expectAppRoute(page, buildSettingsSectionRoute("diagnostics"));
      await expectDiagnosticsContent(page);
      await expectSettingsSidebarHidden(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expectCompactSettingsList(page);
    });

    await test.step("open host details and return through the list", async () => {
      await openCompactSettingsHost(page);
      await expectSettingsBackButton(page);
      await expectSettingsSidebarHidden(page);
      await goBackInSettings(page);
      await expectAppRoute(page, buildSettingsRoute());
      await expectSettingsSidebarVisible(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expect(page).not.toHaveURL(/\/settings(\/|$)/);
    });
  });

  test("environment settings returns through the settings list to the original workspace", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "host-picker-settings-back-" });
    const workspaceRoute = buildHostWorkspaceRoute(getServerId(), workspace.workspaceId);

    await openWorkspace(page, workspace);
    await openCompactSettings(page, workspaceRoute);
    await openSettingsHostSection(page, getServerId(), "host");
    await expectAppRoute(page, buildSettingsSectionRoute("environments"));
    await expect(page.getByTestId(`settings-environment-${getServerId()}`)).toBeVisible();

    await goBackInSettings(page);
    await expectCompactSettingsList(page);

    await goBackInSettings(page);
    await expectAppRoute(page, workspaceRoute);
  });

  test("one Connections section displays both environments without a host picker", async ({
    page,
  }) => {
    const primaryServerId = getServerId();
    const secondaryServerId = "srv_e2e_settings_secondary";
    const secondaryHostLabel = "Stable horse";
    const endpoint = `127.0.0.1:${getE2EDaemonPort()}`;

    await seedSavedSettingsHosts(page, [
      { serverId: primaryServerId, label: "First horse", endpoint },
      { serverId: secondaryServerId, label: secondaryHostLabel, endpoint },
    ]);
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expect(page.getByTestId("settings-host-picker")).toHaveCount(0);

    await expectAppRoute(page, buildSettingsRoute());
    await expectSettingsSidebarVisible(page);

    await openSettingsHostSection(page, secondaryServerId, "connections");
    await expect(page.getByTestId(`settings-environment-${primaryServerId}`)).toContainText(
      "First horse",
    );
    await expect(page.getByTestId(`settings-environment-${secondaryServerId}`)).toContainText(
      secondaryHostLabel,
    );
  });

  test("removing the last active host returns to welcome after settings closes", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "remove-host-compact-" });

    await openWorkspace(page, workspace);
    await openCompactSettings(page, buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await openSettingsHostSection(page, getServerId(), "host");
    await removeCurrentHostFromSettings(page);
    await closeCompactSettings(page);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByTestId("welcome-direct-connection")).toBeVisible();
  });
});

for (const width of [1280, 390]) {
  test(`environment tabs stay visible while details scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 500 });
    const primary = getServerId();
    const secondary = "srv_e2e_environment_tabs";
    const endpoint = `127.0.0.1:${getE2EDaemonPort()}`;
    await seedSavedSettingsHosts(page, [
      { serverId: primary, label: "Host", endpoint },
      { serverId: secondary, label: "Dev container", endpoint },
    ]);
    await page.goto(buildSettingsSectionRoute("environments"));
    const tabs = page.getByTestId("settings-environment-tabs");
    const hostTab = page.getByRole("tab", { name: "Host", exact: true });
    const devTab = page.getByRole("tab", { name: "Dev container", exact: true });
    await expect(hostTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`settings-environment-${primary}`)).toBeVisible();
    await expect(page.getByTestId(`settings-environment-${secondary}`)).toHaveCount(0);
    const initialTabs = await tabs.boundingBox();
    expect(initialTabs).not.toBeNull();
    const scroll = page.getByTestId("settings-environment-scroll");
    await scroll.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(tabs).toBeVisible();
    expect((await tabs.boundingBox())!.y).toBe(initialTabs!.y);
    await devTab.click();
    await expect(devTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`settings-environment-${secondary}`)).toBeAttached();
    await expect(page.getByTestId(`settings-environment-${primary}`)).toHaveCount(0);
    await hostTab.click();
    await expect(hostTab).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: test.info().outputPath(`environment-tabs-${width}.png`) });
  });
}
