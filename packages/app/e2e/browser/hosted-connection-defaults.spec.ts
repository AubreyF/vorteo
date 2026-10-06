import { expect, test, type Page } from "@playwright/test";

async function expectConnectionDefaults(page: Page) {
  const url = new URL(page.url());
  await expect(page.getByTestId("direct-host-input")).toHaveValue(url.hostname);
  await expect(page.getByTestId("direct-port-input")).toHaveValue(
    url.port || (url.protocol === "https:" ? "443" : "80"),
  );
  await expect(page.getByTestId("direct-ssl-toggle-checked")).toHaveCount(
    url.protocol === "https:" ? 1 : 0,
  );
  await expect(page.getByTestId("direct-password-input")).toHaveValue("");
}

for (const vortonMode of [false, true]) {
  test(`hosted defaults ignore legacy product preference ${vortonMode}`, async ({ page }) => {
    // Deny daemon transport while keeping Metro's development sockets alive;
    // closing those sockets reloads the page when a lazy bundle registers.
    await page.routeWebSocket(
      (url) => url.pathname === "/ws",
      (socket) => socket.close({ code: 1008, reason: "Authentication required" }),
    );
    await page.addInitScript((enabled) => {
      localStorage.setItem(
        "@paseo:create-agent-preferences",
        JSON.stringify({ vortonMode: enabled }),
      );
    }, vortonMode);
    await page.goto("/");
    await expect(page.getByTestId("welcome-screen")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("welcome-direct-connection").click();
    await expectConnectionDefaults(page);
    await page.getByTestId("direct-host-input").fill("another-host.example.com");
    await page.getByTestId("direct-password-input").fill("discard-on-cancel");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId("welcome-direct-connection").click();
    await expectConnectionDefaults(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId("welcome-open-settings").click();
    await page.getByTestId("settings-add-host").click();
    await page.getByTestId("add-host-method-direct").click();
    await expectConnectionDefaults(page);
    await page.getByTestId("direct-host-input").fill("settings-edit.example.com");
    await page.getByTestId("direct-password-input").fill("discard-on-back");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId("add-host-method-direct").click();
    await expectConnectionDefaults(page);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem("@paseo:daemon-registry") ?? "[]")),
    ).toEqual([]);

    // Safari can restore this URL, and Settings Back can also navigate here.
    await page.goto("/open-project");
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    await page.getByTestId("welcome-direct-connection").click();
    await expectConnectionDefaults(page);
  });
}

test("a saved offline host retains its project screen", async ({ page }) => {
  await page.routeWebSocket(
    (url) => url.pathname === "/ws",
    (socket) => socket.close({ code: 1008, reason: "Offline test host" }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify({ vortonMode: true }));
    localStorage.setItem(
      "@paseo:daemon-registry",
      JSON.stringify([
        {
          serverId: "srv_saved_offline",
          label: "Saved host",
          connections: [
            { id: "direct:127.0.0.1:45678", type: "directTcp", endpoint: "127.0.0.1:45678" },
          ],
          preferredConnectionId: "direct:127.0.0.1:45678",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
  });
  await page.goto("/open-project");
  await expect(page.getByTestId("open-project-submit")).toBeVisible();
  await expect(page.getByTestId("welcome-screen")).toHaveCount(0);
});
