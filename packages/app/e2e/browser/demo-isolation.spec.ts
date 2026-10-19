import { expect, test } from "../support/fixtures";

test.skip(
  process.env.EXPO_PUBLIC_DEMO_PREVIEW !== "1",
  "Run with the managed demo preview isolation flag.",
);

for (const width of [1800, 390]) {
  test(`isolates demo interactions, reset and exit at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const external: string[] = [];
    let appOrigin: string | undefined;
    const sockets: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!appOrigin && request.isNavigationRequest()) appOrigin = url.origin;
      if (["http:", "https:"].includes(url.protocol) && url.origin !== appOrigin)
        external.push(request.url());
    });
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.addInitScript(() => {
      if (!localStorage.getItem("demo-isolation-sentinel")) {
        localStorage.setItem("demo-isolation-sentinel", "owner-data");
        for (const key of [
          "sidebar-project-workspace-order",
          "sidebar-view",
          "sidebar-collapsed-sections",
          "sidebar-sync-outbox:real-owner",
        ])
          localStorage.setItem(key, "owner-sidebar-data");
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({ theme: "neon", appearanceMode: "dark" }),
        );
      }
    });
    await page.goto("/?demo=1");
    if (width === 390) await page.getByTestId("menu-button").click();
    await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
    const composer = page.getByRole("textbox", { name: "Message agent..." });
    await composer.fill("Show me the available themes");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("Simulated reply", { exact: true })).toBeVisible();
    await expect(page.getByTestId("sidebar-sync-error")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 1800) {
      await page.getByTestId("changes-primary-cta").click();
      await expect(
        page
          .getByText(
            "This action is unavailable in the isolated demo. No real host was contacted.",
            { exact: false },
          )
          .first(),
      ).toBeVisible();
    } else {
      await page.getByTestId("menu-button").click();
    }
    await page.getByTestId("sidebar-footer-overflow").click();
    await page.getByTestId("theme-preview-ember").click();
    await page.mouse.move(width - 10, 890);
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", "ember");
    expect(await page.evaluate(() => localStorage.getItem("@paseo:app-settings"))).toBe(
      JSON.stringify({ theme: "neon", appearanceMode: "dark" }),
    );
    await page.getByTestId("demo-reset").click();
    if (width === 390) await page.getByTestId("menu-button").click();
    await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", "starship-dark");
    expect(
      await page.evaluate(() => sessionStorage.getItem("vorteo:demo:conversations:v1")),
    ).toBeNull();
    await page.getByTestId("demo-exit").click();
    await expect(page.getByRole("button", { name: "Demo", exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("demo-isolation-sentinel"))).toBe(
      "owner-data",
    );
    expect(await page.evaluate(() => localStorage.getItem("@paseo:app-settings"))).toBe(
      JSON.stringify({ theme: "neon", appearanceMode: "dark" }),
    );
    await page.screenshot({ path: info.outputPath(`demo-exit-${width}.png`), fullPage: true });
    expect(
      await page.evaluate(() =>
        Object.fromEntries(
          Object.keys(localStorage)
            .filter((key) => key.startsWith("sidebar-"))
            .map((key) => [key, localStorage.getItem(key)]),
        ),
      ),
    ).toEqual({
      "sidebar-project-workspace-order": "owner-sidebar-data",
      "sidebar-view": "owner-sidebar-data",
      "sidebar-collapsed-sections": "owner-sidebar-data",
      "sidebar-sync-outbox:real-owner": "owner-sidebar-data",
    });
    expect(sockets.filter((url) => !["/hot", "/message"].includes(new URL(url).pathname))).toEqual(
      [],
    );
    expect(external).toEqual([]);
  });
}
