import { expect, type Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";
import { getServerId } from "./server-id";
import { openSettings } from "./app";
import { expectAppRoute } from "./route-assertions";
import { buildSettingsRoute } from "@/utils/host-routes";
import { getSection, resolveSettingsTarget } from "@/settings-catalog/catalog";

const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const REGISTRY_KEY = "@paseo:daemon-registry";

interface SavedSettingsHostInput {
  serverId: string;
  label: string;
  endpoint: string;
}

/** Old settings page names that specs open; the catalog maps each to its new place. */
const OLD_SETTINGS_PAGES = [
  "general",
  "chat",
  "appearance",
  "sidebar",
  "editor",
  "terminal",
  "browser",
  "shortcuts",
  "integrations",
  "permissions",
  "diagnostics",
] as const;

export type SettingsSection = (typeof OLD_SETTINGS_PAGES)[number];

type HostSection =
  | "projects"
  | "connections"
  | "pair-device"
  | "agents"
  | "metadata"
  | "workspaces"
  | "providers"
  | "usage"
  | "terminals"
  | "plugins"
  | "host";

/**
 * Opens a settings location by its old page name. Settings is one scrolling
 * page now; the catalog maps each old name to its section and pane.
 */
export async function openSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();
  await revealSettingsLocation(page, section);
}

/** Scrolls the settings page to the pane that an old settings page name now opens. */
export async function revealSettingsLocation(page: Page, slug: string): Promise<void> {
  const target = resolveSettingsTarget(slug);
  // A drill-in can leave an earlier settings screen mounted but hidden, and a section can also
  // appear in the page body, so use the visible sidebar's entry and the visible anchor.
  const sidebar = page.getByTestId("settings-sidebar").filter({ visible: true }).first();
  const scope = (await sidebar.isVisible()) ? sidebar : page;
  await scope
    .getByTestId(`settings-section-${target.section}`)
    .filter({ visible: true })
    .first()
    .click();
  const anchor = page
    .getByTestId(
      target.pane ? `settings-pane-${target.pane}` : `settings-page-section-${target.section}`,
    )
    .filter({ visible: true })
    .first();
  await expect(anchor).toBeVisible();
  if (target.pane) {
    // A fresh section jump stays pinned until the reader scrolls. Release it
    // with a real gesture before scrolling farther to the requested pane.
    const scroll = page.getByTestId("settings-scroll-page").filter({ visible: true }).first();
    await scroll.hover();
    await page.mouse.wheel(0, 1);
  }
  await anchor.scrollIntoViewIfNeeded();
}

export async function openSettingsHost(page: Page, serverId: string): Promise<void> {
  await openSettingsHostSection(page, serverId, "connections");
  await expect(
    page.getByTestId(`settings-environment-${serverId}`).getByTestId("host-page-connections-card"),
  ).toBeVisible();
}

export async function openSettingsHostSection(
  page: Page,
  serverId: string,
  section: HostSection,
): Promise<void> {
  await revealSettingsLocation(page, section === "host" ? "environments" : section);
  await expect(page.getByTestId("settings-host-picker")).toHaveCount(0);
  if (section === "host" || section === "connections") {
    await selectSettingsEnvironment(page, serverId);
  }
}

/**
 * Environments shows one host at a time. With more than one host, tabs under the heading
 * choose which; a single host has no tabs.
 */
async function selectSettingsEnvironment(page: Page, serverId: string): Promise<void> {
  const tab = page.getByTestId(`settings-environment-tab-${serverId}`);
  if ((await page.getByTestId("settings-environment-tabs").count()) > 0) {
    await tab.click();
  }
  // The section's test ID also marks its heading parts, so match the outermost element.
  await expect(page.getByTestId(`settings-environment-${serverId}`).first()).toBeVisible();
}

/** A section or pane title is visible in the settings page, or a drill-in page's title. */
export async function expectSettingsHeader(page: Page, title: string): Promise<void> {
  const scrollPage = page.getByTestId("settings-scroll-page");
  if (await scrollPage.isVisible()) {
    await expect(scrollPage.getByText(title, { exact: true }).first()).toBeVisible();
    return;
  }
  await expect(page.getByTestId("page-title")).toHaveText(title);
}

export async function openAddHostFlow(page: Page): Promise<void> {
  if (!(await page.getByTestId("settings-add-host").isVisible())) {
    const section = page.getByTestId("settings-section-environments");
    if (!(await section.isVisible())) await goBackInSettings(page);
    await revealSettingsLocation(page, "connections");
  }
  await page.getByTestId("settings-add-host").click();
  await expect(page.getByRole("dialog").filter({ hasText: "Add connection" })).toBeVisible();
}

export async function selectHostConnectionType(
  page: Page,
  type: "direct" | "relay",
): Promise<void> {
  const label = type === "direct" ? "Direct connection" : "Paste pairing link";
  await page.getByRole("button", { name: label }).click();
}

export async function addDirectHostFromSettings(
  page: Page,
  input: { host: string; port: number; password?: string },
): Promise<void> {
  await openAddHostFlow(page);
  await selectHostConnectionType(page, "direct");
  await page.getByTestId("direct-host-input").fill(input.host);
  await page.getByTestId("direct-port-input").fill(String(input.port));
  if (input.password) {
    await page.getByTestId("direct-password-input").fill(input.password);
  }
  await page.getByTestId("direct-host-submit").click();
  await expect(page.getByRole("dialog").filter({ hasText: "Add connection" })).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function toggleHostAdvanced(page: Page): Promise<void> {
  await page.getByTestId("direct-host-advanced-toggle").click();
}

export async function openCompactSettings(page: Page, expectedStartRoute: string): Promise<void> {
  await expectAppRoute(page, expectedStartRoute, { timeout: 15_000 });
  await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
  const settingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expectAppRoute(page, buildSettingsRoute());
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
}

export async function seedSavedSettingsHosts(
  page: Page,
  hosts: SavedSettingsHostInput[],
): Promise<void> {
  await page.goto("/");
  const nowIso = new Date().toISOString();
  const registry = hosts.map((host) =>
    buildSeededHost({
      serverId: host.serverId,
      label: host.label,
      endpoint: host.endpoint,
      nowIso,
    }),
  );
  const firstHost = registry[0];
  if (!firstHost) {
    throw new Error("Expected at least one settings host fixture.");
  }
  const preferences = buildCreateAgentPreferences();

  await page.evaluate(
    ({ keys, storedRegistry, storedPreferences }) => {
      const nonce = localStorage.getItem(keys.seedNonce);
      if (!nonce) {
        throw new Error("Expected e2e seed nonce before overriding settings host registry.");
      }

      localStorage.setItem(keys.registry, JSON.stringify(storedRegistry));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(storedPreferences));
      localStorage.setItem(keys.disableDefaultSeedOnce, nonce);
    },
    {
      keys: {
        disableDefaultSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
        registry: REGISTRY_KEY,
        seedNonce: SEED_NONCE_KEY,
      },
      storedRegistry: registry,
      storedPreferences: preferences,
    },
  );
}

export async function expectCompactSettingsList(page: Page): Promise<void> {
  await expectAppRoute(page, buildSettingsRoute());
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await expect(page.getByText("Theme", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play test" })).toHaveCount(0);
  await expect(page.getByTestId("host-page-connections-card")).toHaveCount(0);
}

export async function expectSettingsSidebarVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
}

export async function expectSettingsSidebarHidden(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="settings-sidebar"]:visible')).toHaveCount(0);
}

export async function expectSettingsSidebarSections(
  page: Page,
  sections: SettingsSection[],
): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  for (const section of sections) {
    const label = getSection(resolveSettingsTarget(section).section).label;
    await expect(sidebar.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
}

export async function goBackInSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back", exact: true }).click();
}

export async function closeCompactSettings(page: Page): Promise<void> {
  await goBackInSettings(page);
  await expect(page).not.toHaveURL(/\/settings(\/|$)/);
}

export async function removeCurrentHostFromSettings(page: Page): Promise<void> {
  await page.getByTestId("host-page-remove-host-button").click();
  await expect(page.getByTestId("remove-host-confirm-modal")).toBeVisible();
  await page.getByTestId("remove-host-confirm").click();
  await expectAppRoute(page, buildSettingsRoute());
}

export async function expectSettingsBackButton(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
}

export async function clickSettingsBackToWorkspace(page: Page): Promise<void> {
  await page.getByTestId("settings-back-to-workspace").click();
}

/**
 * Connections lives in the Environments section. Its own address is kept when
 * opened directly; compact navigation opens the section's address.
 */
export async function expectHostSettingsUrl(page: Page, _serverId: string): Promise<void> {
  await expect(page).toHaveURL(/\/settings\/(connections|environments)$/);
}

export async function verifyLegacyHostSettingsRedirect(page: Page): Promise<void> {
  const serverId = getServerId();
  await page.goto(`/h/${encodeURIComponent(serverId)}/settings`);
  await expectHostSettingsUrl(page, serverId);
}

export async function openCompactSettingsHost(page: Page): Promise<void> {
  const serverId = getServerId();
  await openSettingsHost(page, serverId);
  await expectHostSettingsUrl(page, serverId);
}

export async function expectAddHostMethodOptions(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Direct connection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste pairing link" })).toHaveCount(0);
}

export async function fillDirectHostUri(page: Page, uri: string): Promise<void> {
  await page.getByTestId("direct-host-uri-input").fill(uri);
}

export async function expectDirectHostFormValues(
  page: Page,
  fields: { host: string; port: string; password: string },
): Promise<void> {
  await expect(page.getByTestId("direct-host-input")).toHaveValue(fields.host);
  await expect(page.getByTestId("direct-port-input")).toHaveValue(fields.port);
  await expect(page.getByTestId("direct-password-input")).toHaveValue(fields.password);
}

export async function expectDirectHostSslEnabled(page: Page): Promise<void> {
  await expect(page.getByTestId("direct-ssl-toggle-checked")).toBeVisible();
}

export async function expectDirectHostUriValue(page: Page, uri: string): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveValue(uri);
}

export async function expectDirectHostUriHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveCount(0);
}

export async function expectDiagnosticsContent(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Run" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play test" })).toBeVisible();
}

export async function expectAboutContent(page: Page): Promise<void> {
  await expect(page.getByText("App version", { exact: true }).first()).toBeVisible();
}

export async function expectGeneralContent(page: Page): Promise<void> {
  await expect(page.getByTestId("settings-github")).toBeVisible();
  await expect(page.getByTestId("settings-pane-chat.sending")).toHaveCount(1);
  await expect(page.getByTestId("settings-pane-general.sending")).toHaveCount(0);
}

export async function expectAppearanceContent(page: Page): Promise<void> {
  await expect(page.getByText("Highlight theme", { exact: true }).first()).toBeVisible();
}

export async function expectHostLabelDisplayed(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-label-edit-button")).toBeVisible();
  await expect(page.getByTestId("host-page-rename-modal-input")).toHaveCount(0);
}

export async function clickEditHostLabel(page: Page): Promise<void> {
  await page.getByTestId("host-page-label-edit-button").click();
}

export async function expectHostLabelEditMode(page: Page, expectedLabel: string): Promise<void> {
  await expect(page.getByTestId("host-page-rename-modal-input")).toBeVisible();
  await expect(page.getByTestId("host-page-rename-modal-input")).toHaveValue(expectedLabel);
  await expect(page.getByTestId("host-page-rename-modal-submit")).toBeVisible();
}

export async function expectHostConnectionsCard(page: Page, port: string): Promise<void> {
  const card = page.getByTestId("host-page-connections-card");
  await expect(card).toBeVisible();
  // "Connections" can appear more than once on this page (pane heading and
  // card heading). Match the first to keep the heading assertion without
  // tripping Playwright strict mode.
  await expect(page.getByText("Connections", { exact: true }).first()).toBeVisible();
  await expect(
    card.getByText(new RegExp(`TCP \\((localhost|127\\.0\\.0\\.1):${port}\\)`)),
  ).toBeVisible();
}

export async function expectHostInjectMcpCard(page: Page): Promise<void> {
  const card = page.getByTestId("host-page-inject-mcp-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("switch", { name: "Inject Vorteo tools" })).toBeVisible();
}

export async function openHostSection(
  page: Page,
  serverId: string,
  section: HostSection,
): Promise<void> {
  if (section === "host") {
    // Navigate inside the app: a full page load reseeds the host registry and drops added hosts.
    if (!(await page.getByTestId("settings-scroll-page").isVisible())) {
      await openSettings(page);
    }
    await openSettingsHostSection(page, serverId, "host");
    // Environments renders only the selected host, so its identity badges are unique.
    await expect(page.getByTestId("host-page-identity")).toBeVisible();
    return;
  }
  await openSettingsHostSection(page, serverId, section);
}

export async function expectHostActionCards(page: Page, serverId: string): Promise<void> {
  // Restart + remove cards live on the Host section; providers moved to its
  // own Providers section (asserted via expectHostProvidersCard).
  await openSettingsHostSection(page, serverId, "host");
  await expect(page.getByTestId("host-page-restart-card")).toBeVisible();
  await expect(page.getByTestId("host-page-restart-button")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-button")).toBeVisible();
}

export async function expectHostProvidersCard(page: Page, serverId: string): Promise<void> {
  await openSettingsHostSection(page, serverId, "providers");
  await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
}

export async function serveJson(page: Page, url: string, body: unknown): Promise<void> {
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

export async function openAddProviderArea(page: Page): Promise<void> {
  await page.getByTestId("host-page-add-provider-card").scrollIntoViewIfNeeded();
  await expect(page.getByRole("textbox", { name: "Search providers" })).toBeVisible();
}

export async function findAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search providers" }).fill(providerName);
  await expect(page.getByText(providerName, { exact: true })).toBeVisible();
}

export async function installAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await findAcpCatalogProvider(page, providerName);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

export async function expectProviderInstalledInSettings(
  page: Page,
  providerName: string,
): Promise<void> {
  await expect(
    page.getByRole("button", { name: `${providerName} provider details`, exact: true }),
  ).toBeVisible();
}

export async function expectHostNoDaemonLifecycleRow(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-daemon-lifecycle-card")).toHaveCount(0);
}

export async function expectRetiredSidebarSectionsAbsent(page: Page): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();

  // One entry per section; old pages are panes inside them.
  for (const id of ["general", "accounts", "agents", "environments", "maintenance"]) {
    await expect(sidebar.getByTestId(`settings-section-${id}`)).toBeVisible();
  }
  await expect(sidebar.getByRole("button", { name: "Daemon", exact: true })).toHaveCount(0);
  for (const retired of ["connections", "projects", "providers", "usage", "diagnostics", "about"]) {
    await expect(sidebar.getByTestId(`settings-section-${retired}`)).toHaveCount(0);
  }

  // No host selection changes the meaning of these settings.
  await expect(sidebar.locator('[data-testid^="settings-host-entry-"]')).toHaveCount(0);
}

export async function expectHostPageVisible(page: Page, _serverId: string): Promise<void> {
  await expect(page.getByTestId("host-page-connections-card")).toBeVisible();
}

export async function expectLocalHostEntryFirst(page: Page, _serverId: string): Promise<void> {
  await expect(page.getByTestId("settings-sidebar")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("settings-host-picker")).toHaveCount(0);
  await expect(page.getByTestId("settings-section-environments")).toBeVisible();
}

export async function expectHostRejectedWithReAddGuidance(
  page: Page,
  reason: string,
): Promise<void> {
  // Environments and Connections both show the host's connection error; check the first.
  const error = page.getByTestId("host-connection-error").first();
  await expect(error).toContainText(reason);
  await expect(error).toContainText(
    "Remove this host and add it again with the password this daemon asks for.",
  );
}

export async function expectNoHostPasswordControls(page: Page): Promise<void> {
  await expect(page.getByText("Password", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /password/i })).toHaveCount(0);
}

export async function removeHostFromHostPage(page: Page, serverId: string): Promise<void> {
  await page.getByTestId("host-page-remove-host-button").click();
  await page.getByTestId("remove-host-confirm").click();
  await expect(page).not.toHaveURL(new RegExp(`/settings/hosts/${serverId}`));
}

export async function expectHostOnlineWithoutError(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-identity")).toContainText("Online");
  await expect(page.getByTestId("host-connection-error")).toHaveCount(0);
}
