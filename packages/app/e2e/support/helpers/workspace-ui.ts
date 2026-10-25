import { expect, type Locator, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { gotoHome } from "./app";
import { expectAppRoute } from "./route-assertions";

export async function sidebarProjectForWorkspace(row: Locator) {
  return row.evaluate((element) => {
    let parent = element.parentElement;
    while (parent) {
      const project = parent.querySelector('[data-testid^="sidebar-project-row-"]');
      if (project) return project.getAttribute("data-testid");
      parent = parent.parentElement;
    }
    return null;
  });
}

export async function openNewAgentComposer(page: Page): Promise<void> {
  await gotoHome(page);
}

/**
 * Wait for the sidebar to show at least one project row. Use this after a spec
 * seeds a workspace/project; zero-project flows need their own assertion.
 */
export async function waitForSidebarHydration(page: Page, timeout = 60_000): Promise<void> {
  // The shell keeps a hidden copy of the other layout's sidebar, so wait for a visible row.
  await page
    .locator('[data-testid^="sidebar-project-row-"]:visible')
    .first()
    .waitFor({ state: "visible", timeout });
}

export async function waitForNoProjectsInSidebar(page: Page, timeout = 60_000): Promise<void> {
  await page.getByTestId("sidebar-project-empty-state").waitFor({ state: "visible", timeout });
}

function workspaceRowLocator(page: Page, serverId: string, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`).first();
}

export async function expectSidebarWorkspaceSelected(input: {
  page: Page;
  serverId: string;
  workspaceId: string;
  selected?: boolean;
}): Promise<void> {
  const row = workspaceRowLocator(input.page, input.serverId, input.workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const expected = input.selected === false ? "false" : "true";

  const hasDataSelected = await row.getAttribute("data-selected");
  if (hasDataSelected !== null) {
    await expect(row).toHaveAttribute("data-selected", expected, {
      timeout: 30_000,
    });
    return;
  }

  await expect(row).toHaveAttribute("aria-selected", expected, {
    timeout: 30_000,
  });
}

export async function switchWorkspaceViaSidebar(input: {
  page: Page;
  serverId: string;
  workspaceId: string;
}): Promise<void> {
  const row = workspaceRowLocator(input.page, input.serverId, input.workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const targetWorkspaceRoute = buildHostWorkspaceRoute(input.serverId, input.workspaceId);
  await expectAppRoute(input.page, targetWorkspaceRoute, { timeout: 30_000 });
}

/**
 * Wait for a workspace's sidebar row to appear, confirming the workspace
 * descriptor has been hydrated into the session store.
 */
export async function waitForWorkspaceInSidebar(
  page: Page,
  input: { serverId: string; workspaceId: string },
): Promise<void> {
  await workspaceRowLocator(page, input.serverId, input.workspaceId).waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

/**
 * Phones show a workspace header with the workspace title and its project. Desktop has no
 * workspace header (60f4899a6), so there the selected sidebar row names the workspace under
 * its project row.
 */
export async function expectWorkspaceHeader(
  page: Page,
  input: { title: string; subtitle: string },
): Promise<void> {
  const titleLocator = page.getByTestId("workspace-header-title").filter({ visible: true });
  const subtitleLocator = page.getByTestId("workspace-header-subtitle").filter({ visible: true });
  const routeRow = page
    .locator('[data-testid^="sidebar-workspace-row-"]')
    .filter({ visible: true });

  // Phones show the title header. Desktop has none since 195e1c044, so read the open workspace's
  // sidebar row, found from the route: status-grouped rows expose no selected state.
  await expect(titleLocator.or(routeRow).first()).toBeVisible({ timeout: 30_000 });
  if ((await titleLocator.count()) > 0) {
    await expect(titleLocator.first()).toHaveText(input.title, { timeout: 30_000 });
    await expect(subtitleLocator.first()).toHaveText(input.subtitle, { timeout: 30_000 });
    return;
  }
  await expect(page).toHaveURL(/\/h\/[^/]+\/workspace\/[^/?#]+/, { timeout: 30_000 });
  const match = /\/h\/([^/]+)\/workspace\/([^/?#]+)/.exec(new URL(page.url()).pathname);
  const row = page
    .getByTestId(
      `sidebar-workspace-row-${decodeURIComponent(match![1])}:${decodeURIComponent(match![2])}`,
    )
    .filter({ visible: true })
    .first();
  await expect(row).toContainText(input.title, { timeout: 30_000 });
  // Project grouping names the project on its section row. Status grouping shows only the
  // project's icon in the row, so there is no project name to read.
  if (await page.getByTestId("sidebar-status-list-scroll").isVisible()) return;
  await expect(
    page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ visible: true })
      .filter({ hasText: input.subtitle })
      .first(),
  ).toBeVisible();
}

export async function expectReconnectingToastVisible(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  const toast = page.getByRole("alert").filter({ hasText: "Reconnecting host" });
  await expect(toast).toBeVisible({
    timeout: options?.timeout ?? 30_000,
  });
  await expect(toast).toHaveText("Reconnecting host");
}

export async function expectReconnectingToastGone(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(page.getByRole("alert").filter({ hasText: "Reconnecting host" })).toHaveCount(0, {
    timeout: options?.timeout ?? 30_000,
  });
}

declare global {
  interface Window {
    __shownPanelToasts?: string[];
  }
}

export interface PanelToastLog {
  /** Test ids of every toast that entered the DOM since recording started, in order. */
  shown(): Promise<string[]>;
  expectNeverShown(testId: string): Promise<void>;
}

/**
 * Record every toast that enters the DOM from the next navigation onward. A toast can appear
 * and disappear within a few frames, so a settled `toHaveCount(0)` cannot prove one never showed.
 */
export async function recordPanelToasts(page: Page): Promise<PanelToastLog> {
  await page.addInitScript(() => {
    const shown: string[] = [];
    window.__shownPanelToasts = shown;
    const record = (node: Element) => {
      if (node.getAttribute("role") !== "alert") return;
      shown.push(node.getAttribute("data-testid") ?? "");
    };
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          record(node);
          for (const descendant of node.querySelectorAll('[role="alert"]')) record(descendant);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });

  const shown = () => page.evaluate(() => window.__shownPanelToasts ?? []);
  return {
    shown,
    async expectNeverShown(testId: string): Promise<void> {
      expect(await shown()).not.toContain(testId);
    },
  };
}

export async function expectHostConnectingOrOffline(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(
    page.getByText(/^Connecting$|localhost is offline|Cannot reach localhost/i),
  ).toBeVisible({ timeout: options?.timeout ?? 30_000 });
}

export async function expectMenuButtonVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("menu-button")).toBeVisible();
}

/**
 * The open workspace's title. Phones show it in the screen header; desktop has no title header
 * since 195e1c044, so the selected sidebar row carries it.
 */
export function workspaceTitleLocator(page: Page): Locator {
  return page
    .getByTestId("workspace-header-title")
    .filter({ visible: true })
    .or(
      page
        .locator('[data-testid^="sidebar-workspace-row-"][aria-selected="true"]')
        .filter({ visible: true }),
    )
    .first();
}

export async function expectWorkspaceTitle(page: Page, title: string): Promise<void> {
  await expect(workspaceTitleLocator(page)).toContainText(title, { timeout: 30_000 });
}

export async function expectWorkspaceHeaderAbsent(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-header-title")).toHaveCount(0);
}

export function workspaceDeckEntryLocator(page: Page, serverId: string, workspaceId: string) {
  return page.getByTestId(`workspace-deck-entry-${serverId}:${workspaceId}`);
}

export async function expectWorkspaceDeckEntryCount(page: Page, count: number): Promise<void> {
  await expect(page.locator('[data-testid^="workspace-deck-entry-"]')).toHaveCount(count);
}

export async function seedWorkspaceActivity(page: Page, marker: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message agent..." });
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(marker);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
}

/**
 * Opens the workspace's own actions menu. Phones keep it in the title bar; on desktop the
 * primary pane's menu combines it with pane splitting (195e1c044). Returns the menu content.
 */
export async function openWorkspaceActionsMenu(
  page: Page,
  options: { tap?: boolean } = {},
): Promise<Locator> {
  const title = page.getByTestId("workspace-header-menu-trigger").filter({ visible: true });
  const pane = page.getByTestId("workspace-split-pane-menu").filter({ visible: true });
  const trigger = title.or(pane).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  const onTitle = (await title.count()) > 0;
  if (options.tap) await trigger.tap();
  else await trigger.click();
  // Phones open the title menu as a sheet, whose scroll content carries the "-content" test ID.
  const content = (
    onTitle
      ? page
          .getByTestId("workspace-header-menu")
          .or(page.getByTestId("workspace-header-menu-content"))
      : page.getByTestId("workspace-split-pane-menu-content")
  )
    .filter({ visible: true })
    .first();
  await expect(content).toBeVisible();
  return content;
}
