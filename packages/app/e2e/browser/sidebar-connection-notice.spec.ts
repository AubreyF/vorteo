import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

for (const width of [1400, 390]) {
  test(`connection notice stays in the sidebar and clears on recovery at ${width}px`, async ({
    page,
  }, info) => {
    const project = await seedWorkspace({ repoPrefix: "sidebar-connection-" });
    let offline = false;
    let clientSocket: WebSocketRoute | undefined;
    let serverSocket: WebSocketRoute | undefined;
    await page.routeWebSocket(
      (url) => url.port === String(getE2EDaemonPort()),
      async (socket) => {
        if (offline) {
          await socket.close({ code: 1013, reason: "Test connection outage" });
          return;
        }
        clientSocket = socket;
        serverSocket = socket.connectToServer();
      },
    );
    try {
      await page.setViewportSize({ width, height: 900 });
      await gotoAppShell(page);
      if (width < 720) await page.getByRole("button", { name: "Open menu", exact: true }).click();
      await waitForSidebarHydration(page);
      await expect
        .poll(async () => (await project.client.readSidebarState()).snapshot.state !== null)
        .toBe(true);
      offline = true;
      await Promise.all([clientSocket?.close(), serverSocket?.close()]);
      const notice = page.getByTestId("sidebar-sync-error").filter({ visible: true });
      await expect(notice).toContainText("Host unavailable", { timeout: 20000 });
      await expect(
        page.getByTestId("installation-update-toasts").getByTestId("sidebar-sync-error"),
      ).toHaveCount(0);
      await notice.click();
      await expect(notice).toBeVisible();
      await page.screenshot({ path: info.outputPath("connection-sidebar.png") });
      if (width >= 720) {
        await page.getByTestId("sidebar-collapse").click();
        await expect(notice).toBeVisible();
        await expect(notice).toHaveAttribute("aria-label", /Host unavailable/);
        await expect(notice).toHaveText("");
        await notice.hover();
        await expect(page.getByText("Host unavailable", { exact: true })).toBeVisible();
        await page.mouse.move(600, 400);
      }
      offline = false;
      await expect(page.getByTestId("sidebar-sync-error")).toHaveCount(0, { timeout: 30000 });
    } finally {
      offline = false;
      await project.cleanup();
    }
  });
}
