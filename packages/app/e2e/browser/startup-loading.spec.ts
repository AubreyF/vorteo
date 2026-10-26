import { expect, test } from "../support/fixtures";
import { startupScenario } from "../support/helpers/startup-dsl";

test.describe("Startup loading presentation", () => {
  test("mobile reconnect preserves the saved host shell", async ({ page }) => {
    const startup = await startupScenario(page)
      .withMobileViewport()
      .withSavedHost({
        serverId: "srv_unreachable_mobile",
        label: "Dev",
        endpoint: "127.0.0.1:45678",
      })
      .openRoot();

    await startup.expectsSavedHostShell({ serverId: "srv_unreachable_mobile", label: "Dev" });
    await startup.expectsNoSavedHostErrorStatus();
    await startup.expectsNoLocalServerStartupCopy();
  });
});

test("Vorteo explains an unreachable saved workspace after ten seconds", async ({ page }) => {
  await page.clock.install();
  await startupScenario(page)
    .withMobileViewport()
    .withVortonMode()
    .withSavedHost({ serverId: "srv_unreachable", label: "Dev", endpoint: "127.0.0.1:45678" })
    .openHostWorkspace({ serverId: "srv_unreachable", workspaceId: "saved-workspace" });

  await expect(page.getByTestId("startup-status")).toBeVisible();
  await expect(page.getByTestId("startup-diagnostics")).toHaveCount(0);
  await page.clock.fastForward(10_000);
  await expect(page.getByTestId("startup-diagnostics")).toBeVisible();
  // The connection diagnostics in 24e167c54 replaced the "host is awake" hint.
  await expect(page.getByText(/Check your connection and VPN/)).toBeVisible();
});
