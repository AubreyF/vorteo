import { buildOpenProjectRoute } from "../../app/src/utils/host-routes";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import {
  openHostSection,
  openCompactSettings,
  revealSettingsLocation,
  openSettingsHost,
  seedSavedSettingsHosts,
} from "../../app/e2e/support/helpers/settings";
import {
  loadRealDaemonState,
  installDesktopRuntime,
  openDesktopAboutSettings,
  openDesktopSettings,
  expectUpdateBanner,
  clickInstallUpdate,
  expectInstallInProgress,
  interceptDaemonManagementConfirmDialog,
  interceptDaemonStopConfirmDialog,
  toggleDaemonManagement,
  expectDaemonManagementConfirmDialog,
  expectDaemonManagementEnabled,
  expectDaemonManagementDisabled,
  expectDaemonStatusPid,
  expectDaemonStatusLogPath,
  expectDaemonStatusVersion,
} from "./support/runtime";

async function expectReadableAppUpdateRow(page: Page, testInfo: TestInfo): Promise<Locator> {
  const row = page.getByText("App updates", { exact: true }).locator("../..");
  await row.screenshot({ path: testInfo.outputPath("app-updates-row.png") });
  const geometry = await row.evaluate((element) => {
    const title = [...element.querySelectorAll("*")].find(
      (node) => node.textContent === "App updates" && node.children.length === 0,
    );
    if (!title) throw new Error("App updates label missing");
    const range = document.createRange();
    range.selectNodeContents(title);
    const label = title.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll('[role="button"], button')].map((button) =>
      button.getBoundingClientRect(),
    );
    return {
      titleLines: range.getClientRects().length,
      buttonCount: buttons.length,
      contained: buttons.every(
        (button) =>
          button.left >= bounds.left &&
          button.right <= bounds.right + 1 &&
          button.top >= bounds.top &&
          button.bottom <= bounds.bottom + 1,
      ),
      separateFromTitle: buttons.every(
        (button) => button.left >= label.right || button.top >= label.bottom,
      ),
      noOverflow: element.scrollWidth <= element.clientWidth + 1,
    };
  });
  expect(geometry).toEqual({
    titleLines: 1,
    buttonCount: 2,
    contained: true,
    separateFromTitle: true,
    noOverflow: true,
  });
  return row;
}

// These renderer cases use the Desktop bridge fixture. Actual Electron ownership
// and native confirmation journeys live in daemon-lifecycle.e2e.mjs.
test.describe("Desktop updates", () => {
  test("a desktop-managed daemon explains why its update action is disabled", async ({
    page,
    desktopManagedOutdatedDaemon,
  }) => {
    await seedSavedSettingsHosts(page, [desktopManagedOutdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, desktopManagedOutdatedDaemon.serverId);
    await openHostSection(page, desktopManagedOutdatedDaemon.serverId, "host");

    const updateCard = page.getByTestId("host-page-update-card");
    await expect(updateCard).toBeVisible();
    await expect(updateCard).toContainText(
      "This daemon is managed by Vorteo Desktop. Update Vorteo Desktop on the host.",
    );
    await expect(page.getByTestId("host-page-update-button")).toBeDisabled();
  });

  test("clicking install shows the installing state on the callout", async ({ page }) => {
    await installDesktopRuntime(page, {
      serverId: getServerId(),
      updateAvailable: true,
      latestVersion: "1.2.3",
      slowInstall: true,
    });
    await gotoAppShell(page);

    await expectUpdateBanner(page, "1.2.3");
    await clickInstallUpdate(page);
    await expectInstallInProgress(page);
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "compact", width: 390, height: 844 },
  ]) {
    test.describe(viewport.name, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });
      test("manual check reports a found update while it downloads", async ({ page }, testInfo) => {
        await installDesktopRuntime(page, {
          serverId: getServerId(),
          updateAvailable: true,
          latestVersion: "1.2.3",
          updateReadyToInstall: false,
        });
        await gotoAppShell(page);
        if (viewport.name === "compact") {
          await openCompactSettings(page, buildOpenProjectRoute());
          await revealSettingsLocation(page, "about");
          await page.getByText("App updates", { exact: true }).scrollIntoViewIfNeeded();
        } else {
          await openDesktopAboutSettings(page);
        }
        const row = await expectReadableAppUpdateRow(page, testInfo);
        await row.getByRole("button", { name: "Check", exact: true }).click();

        await expect(row).toContainText("Update found: v1.2.3. Downloading...");
        await expect(row.getByText("Ready to install: v1.2.3")).toHaveCount(0);
        await expect(row.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
        await expectReadableAppUpdateRow(page, testInfo);
      });

      test("manual update remains available after the automatic rollout recheck", async ({
        page,
      }, testInfo) => {
        await installDesktopRuntime(page, {
          serverId: getServerId(),
          latestVersion: "1.2.3",
          manualUpdateBypassesRollout: true,
        });
        await gotoAppShell(page);
        if (viewport.name === "compact") {
          await openCompactSettings(page, buildOpenProjectRoute());
          await revealSettingsLocation(page, "about");
          await page.getByText("App updates", { exact: true }).scrollIntoViewIfNeeded();
        } else {
          await openDesktopAboutSettings(page);
        }
        const row = await expectReadableAppUpdateRow(page, testInfo);
        await row.getByRole("button", { name: "Check", exact: true }).click();
        await expect(row).toContainText("Update found: v1.2.3. Downloading...");
        await expect(row.getByText("Ready to install: v1.2.3")).toHaveCount(0);
        await expect(row.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
        await expect(row.getByText("Ready to install: v1.2.3")).toBeVisible({ timeout: 15_000 });
        await expect(
          row.getByRole("button", { name: "Update to v1.2.3", exact: true }),
        ).toBeEnabled();
        await expectReadableAppUpdateRow(page, testInfo);
      });
    });
  }
});

test.describe("Desktop daemon management", () => {
  test("cancelling the management confirmation preserves the enabled daemon", async ({ page }) => {
    const serverId = getServerId();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      ownedByDesktop: true,
      confirmShouldAccept: false,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    const dialogArgs = await interceptDaemonManagementConfirmDialog(page);
    expectDaemonManagementConfirmDialog(dialogArgs);

    await expectDaemonManagementEnabled(page);
  });

  test("confirming the dialog disables built-in daemon management", async ({ page }) => {
    const serverId = getServerId();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      ownedByDesktop: true,
      confirmShouldAccept: true,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await toggleDaemonManagement(page, "disable");

    await expectDaemonManagementDisabled(page);
  });

  test("daemon status panel renders version, PID, and log path from the real daemon", async ({
    page,
  }) => {
    const serverId = getServerId();
    const realState = await loadRealDaemonState();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: false,
      daemonPid: realState.pid,
      daemonVersion: realState.version,
      daemonLogPath: realState.logPath,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expectDaemonStatusVersion(page, realState.version);
    await expectDaemonStatusPid(page, realState.pid);
    await expectDaemonStatusLogPath(page, realState.logPath);
  });

  for (const confirmShouldAccept of [false, true]) {
    test(`${confirmShouldAccept ? "confirming" : "cancelling"} Stop identifies the owned daemon`, async ({
      page,
    }) => {
      const serverId = getServerId();
      const realState = await loadRealDaemonState();
      const daemonHome = process.env.E2E_PASEO_HOME!;
      await installDesktopRuntime(page, {
        serverId,
        daemonPid: realState.pid,
        daemonHome,
        ownedByDesktop: true,
        confirmShouldAccept,
      });
      await gotoAppShell(page);
      await openDesktopSettings(page, serverId);

      const dialog = await interceptDaemonStopConfirmDialog(page);
      expect(dialog).toEqual({
        title: "Stop local daemon?",
        message: [
          "This daemon was launched by this Desktop session.",
          `Home: ${daemonHome}`,
          `Supervisor PID: ${realState.pid}`,
          "Running agent work will be interrupted.",
        ].join("\n"),
      });
      await expectDaemonStatusPid(page, confirmShouldAccept ? null : realState.pid);
    });
  }
});
