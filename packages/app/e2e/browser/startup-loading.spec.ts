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

test("Vorteo explains an unreachable saved workspace after three seconds", async ({ page }) => {
  await page.clock.install();
  await startupScenario(page)
    .withMobileViewport()
    .withVortonMode()
    .withSavedHost({ serverId: "srv_unreachable", label: "Dev", endpoint: "127.0.0.1:45678" })
    .openHostWorkspace({ serverId: "srv_unreachable", workspaceId: "saved-workspace" });

  await expect(page.getByTestId("startup-status")).toBeVisible();
  await expect(page.getByTestId("startup-diagnostics")).toHaveCount(0);
  await page.clock.fastForward(3_000);
  await expect(page.getByTestId("startup-diagnostics")).toBeVisible();
  // The connection diagnostics in 24e167c54 replaced the "host is awake" hint.
  await expect(page.getByText(/Check your connection and VPN/)).toBeVisible();
});

for (const stylesheet of ["react-native-stylesheet", "unistyles-web"]) {
  test(`startup stays covered until ${stylesheet} applies`, async ({ page }, testInfo) => {
    await page.addInitScript((id) => {
      const hold = () => {
        const style = document.getElementById(id);
        if (style && style.getAttribute("media") !== "not all") {
          style.setAttribute("media", "not all");
        }
      };
      const observer = new MutationObserver(hold);
      observer.observe(document, { childList: true, subtree: true });
      Reflect.set(window, "releaseStartupStyles", () => {
        observer.disconnect();
        document.getElementById(id)?.removeAttribute("media");
      });
    }, stylesheet);
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.locator(`#${stylesheet}`)).toHaveAttribute("media", "not all");
    await expect(page.locator("#boot-help")).toBeVisible({ timeout: 6000 });
    await expect(page.locator("#boot-overlay")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${stylesheet}-held.png`) });
    await page.evaluate(() => Reflect.get(window, "releaseStartupStyles")());
    await expect(page.locator("#boot-overlay")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${stylesheet}-ready.png`) });
  });
}

for (const outcome of ["delayed", "failed"] as const) {
  test(`a ${outcome} required stylesheet keeps startup covered`, async ({ page }) => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldRequests = 0;
    await page.route(
      "**/appearance-fonts/vorton-fonts-6e84901.css?startup-required",
      async (route) => {
        heldRequests++;
        await pending;
        await route.continue();
      },
    );
    await page.addInitScript((styleOutcome) => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector("#root > *")) return;
        observer.disconnect();
        const link = document.createElement("link");
        link.id = "startup-required-styles";
        link.rel = "stylesheet";
        link.href =
          styleOutcome === "failed"
            ? "/__missing-startup-style.css"
            : "/appearance-fonts/vorton-fonts-6e84901.css?startup-required";
        document.head.appendChild(link);
      });
      observer.observe(document, { childList: true, subtree: true });
    }, outcome);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    try {
      await expect(page.locator("#root")).not.toBeEmpty();
      await expect(page.locator("#boot-help")).toBeVisible({ timeout: 6000 });
      await expect(page.locator("#boot-overlay")).toBeVisible();
      await expect(page.locator("#root")).toHaveAttribute("inert", "");
      if (outcome === "failed") {
        await expect(page.locator("#boot-diagnostics")).toContainText(
          "Interface styles: Download failed",
        );
        await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
        await page.locator("#boot-copy").click();
        // Recovery stays available even when the browser rejects clipboard access.
        await expect(page.locator("#boot-copy-feedback")).not.toBeEmpty();
      } else {
        expect(heldRequests).toBe(1);
        release();
        await expect(page.locator("#boot-overlay")).toHaveCount(0);
        await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
      }
    } finally {
      release();
    }
  });
}

test("optional font failure still reveals a styled interface", async ({ page }) => {
  let failedRequests = 0;
  await page.route("**/appearance-fonts/vorton-fonts-6e84901.css", async (route) => {
    failedRequests++;
    await route.fulfill({ status: 404, body: "Font stylesheet unavailable" });
  });
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator("#boot-overlay")).toHaveCount(0);
  expect(failedRequests).toBe(1);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});
