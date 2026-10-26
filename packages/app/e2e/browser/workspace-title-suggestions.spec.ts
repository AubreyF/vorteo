import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, daemonTest, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";

test.setTimeout(180_000);

async function setMode(page: Page, vortonMode: boolean) {
  await page.evaluate((enabled) => {
    localStorage.setItem(
      "@paseo:e2e-disable-default-seed-once",
      localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
    );
    const key = "@paseo:create-agent-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: enabled }),
    );
  }, vortonMode);
  await page.reload();
}

async function openRename(page: Page, key: string) {
  const row = page.getByTestId(`sidebar-workspace-row-${key}`);
  await row.hover();
  // Touch and compact rows have no overflow button (2415534c8); their context menu carries the
  // same items.
  const kebab = page.getByTestId(`sidebar-workspace-kebab-${key}`);
  const shown = await kebab
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (shown) await kebab.click();
  else await row.click({ button: "right" });
  await page.getByTestId(`sidebar-workspace-menu-rename-${key}`).click();
}

test("title failures use a warning card and preserve manual rename", async ({ page }, info) => {
  const workspace = await seedWorkspace({ repoPrefix: "title-warning-" });
  try {
    await gotoAppShell(page);
    const key = `${getServerId()}:${workspace.workspaceId}`;
    const row = page.getByTestId(`sidebar-workspace-row-${key}`);
    const modal = `sidebar-workspace-rename-modal-${key}`;
    await expect(row).toBeVisible();
    await setMode(page, true);
    await openRename(page, key);
    const warning = page.getByTestId("workspace-title-warning");
    await expect(warning).toHaveAttribute("role", "alert");
    await expect(warning).toContainText("Send a message before requesting title suggestions.");
    await expect(warning.locator("svg")).toBeVisible();
    expect(await warning.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe(
      "solid",
    );
    expect(await warning.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    await page.screenshot({ path: info.outputPath("warning-desktop.png") });
    await page.getByTestId("workspace-title-regenerate").click();
    await expect(warning).toBeVisible();
    await page.getByTestId(`${modal}-input`).fill("Manually named workspace");
    await page.getByTestId(`${modal}-submit`).click();
    await expect(row).toContainText("Manually named workspace");
    // Retired 2026-10-25: the Standard mode half, which hid suggestions, went with the mode in
    // 471d7f22a.
    await page.setViewportSize({ width: 390, height: 844 });
    await setMode(page, true);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await openRename(page, key);
    await expect(warning).toBeVisible();
    await page.screenshot({ path: info.outputPath("warning-compact.png") });
    const bounds = await warning.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.getByTestId(`${modal}-cancel`).click();
  } finally {
    await workspace.cleanup();
  }
});

daemonTest.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: Object.fromEntries(
        ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((provider) => [
          provider,
          { enabled: false },
        ]),
      ),
    },
  },
});

daemonTest(
  "an empty metadata catalog keeps title support and returns an actionable error",
  async () => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "title-no-model-",
      title: "Metadata catalog check",
      initialPrompt: "emit 2 agent stream updates",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "title-no-model" });
    try {
      await client.getProvidersSnapshot();
      expect(client.getLastServerInfoMessage()?.features?.workspaceTitleSuggestions).toBe(true);
      await expect(client.suggestWorkspaceTitles(workspace.workspaceId, false)).rejects.toThrow(
        "No metadata model is available.",
      );
    } finally {
      await client.close();
      await workspace.cleanup();
    }
  },
);
