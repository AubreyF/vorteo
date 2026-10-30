import type { Locator } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { delayAgentBootstrapTailResponse } from "../support/helpers/agent-timeline-gate";

// Sample the rendered pixels on either side of the ribbon crossing.
async function expectLoopShading(mark: Locator): Promise<void> {
  await expect(async () => {
    const screenshot = await mark.screenshot();
    const ratio = await mark.page().evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      function brightness(x: number): number {
        const pixel = context!.getImageData(
          Math.round((x / 640) * image.width),
          Math.round((300 / 640) * image.height),
          1,
          1,
        ).data;
        return pixel[0] + pixel[1] + pixel[2];
      }
      return brightness(220) / brightness(270);
    }, screenshot.toString("base64"));
    expect(ratio).toBeLessThan(0.9);
  }).toPass({ timeout: 10_000 });
}

// One theme per cached boot-brand mode: rainbow, white and gradient.
for (const theme of ["starship-light", "starship-dark", "neon"]) {
  test(`embedded and startup logos follow ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1133, height: 744 });
    await page.addInitScript((selected) => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: selected }));
    }, theme);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "logo-palette-",
      title: "Logo palette",
      initialPrompt: "Hello",
    });
    const gate = await delayAgentBootstrapTailResponse(page, session.agentId);
    try {
      await openAgentRoute(page, session);
      await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", theme);
      const mark = page.getByTestId("loading-brand-mark").first();
      await expect(mark).toBeVisible();
      expect((await mark.boundingBox())!.width).toBeCloseTo(43.2, 1);
      await page.screenshot({ path: info.outputPath(`logo-${theme}.png`) });
      // Every palette tints the same master, so the loop is shaded everywhere.
      await expectLoopShading(mark);
      expect(await mark.locator("stop").count()).toBe(2);
      await expect(mark.locator("img")).toHaveCount(0);
      const brand = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("vorteo-boot-brand-v1")!),
      );
      let expectedMode = "gradient";
      if (theme === "starship-light") expectedMode = "rainbow";
      if (theme === "starship-dark") expectedMode = "white";
      expect(brand.mode).toBe(expectedMode);
      // Exported builds load _expo/static/js/web/*.js; the Metro dev server loads *.bundle. Block
      // both so the app cannot boot and replace the startup logo before the checks below run.
      await page.route(/\/_expo\/static\/js\/web\/[^/]+\.js(\?|$)|\.bundle(\?|$)/, (route) =>
        route.abort(),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#boot-status")).toBeVisible();
      await expect(page.locator("#boot-tinted-mark")).toBeVisible();
      await expectLoopShading(page.locator("#boot-tinted-mark"));
      await expect(page.locator("img.boot-mark")).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`startup-logo-${theme}.png`) });
    } finally {
      gate.release();
      gate.releaseCatchUp();
      await session.cleanup();
    }
  });
}

// No daemon fixture: these checks exercise the unauthenticated welcome route.
import { test as bootTest } from "@playwright/test";
type BootTestWindow = Window & { __bootFade: Animation; __vorteoFinishBoot: () => void };

for (const [theme, background, foreground, label = theme] of [
  ["starship-light", "#e2e2ee", "#16163a"],
  ["starship-light", "#222222", "#f5f5f7", "changed preference"],
]) {
  bootTest(`saved startup palette and welcome fade for ${label}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.routeWebSocket(
      (url) => url.pathname === "/ws",
      (socket) => socket.close(),
    );
    await page.addInitScript(
      ({ theme: selectedTheme, background: savedBackground, foreground: savedForeground }) => {
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: selectedTheme }));
        localStorage.setItem(
          "vorteo-boot-brand-v1",
          JSON.stringify({
            mode: selectedTheme === "starship-light" ? "rainbow" : "white",
            start: "#ffffff",
            end: "#cccccc",
            background: savedBackground,
            foreground: savedForeground,
            colorScheme:
              selectedTheme === "starship-light" || selectedTheme === "scriptorium"
                ? "light"
                : "dark",
          }),
        );
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (frames, options) {
          const animation = animate.call(this, frames, options);
          if (this.id === "boot-overlay") {
            animation.pause();
            (window as unknown as BootTestWindow).__bootFade = animation;
          }
          return animation;
        };
      },
      { theme, background, foreground },
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/_expo/static/js/web/*.js", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/welcome", { waitUntil: "commit" });
    const overlay = page.locator("#boot-overlay");
    await expect(page.locator("#boot-status")).toBeVisible();
    expect(
      await page
        .locator("html")
        .evaluate((node) => getComputedStyle(node).getPropertyValue("--boot-background").trim()),
    ).toBe(background);
    release();
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    await expect(overlay).toHaveAttribute("data-leaving", "true");
    expect(
      await page.evaluate(
        () => (window as unknown as BootTestWindow).__bootFade.effect!.getTiming().duration,
      ),
    ).toBe(350);
    await expect(overlay).toHaveCSS("pointer-events", "none");
    await page.evaluate(() => {
      (window as unknown as BootTestWindow).__bootFade.currentTime = 175;
    });
    const opacity = await overlay.evaluate((node) => Number(getComputedStyle(node).opacity));
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    await page.screenshot({ path: info.outputPath("mid-fade.png") });
    await page.evaluate(() => (window as unknown as BootTestWindow).__bootFade.play());
    await expect(overlay).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", theme);
    const cache = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("vorteo-boot-brand-v1")!),
    );
    expect(
      await page
        .getByTestId("welcome-screen")
        .locator("..")
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe(await page.locator("html").evaluate((node) => getComputedStyle(node).backgroundColor));
    expect(cache.background).toBe(
      await page
        .locator("html")
        .evaluate((node) =>
          (node as HTMLElement).style.getPropertyValue("--vorteo-shell-background").trim(),
        ),
    );
    await page.getByTestId("welcome-direct-connection").click();
    await expect(page.getByTestId("direct-password-input")).toBeVisible();
  });
}

bootTest(
  "startup fallback and reduced-motion handoff remain usable without storage",
  async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("Storage disabled");
        },
      });
    });
    await page.route("**/_expo/static/js/web/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const overlay = page.locator("#boot-overlay");
    await expect(overlay).toHaveCSS("background-color", "rgb(34, 34, 34)");
    await expect(page.locator("#boot-status")).toBeVisible();
    await expect(page.locator(".boot-spinner")).toHaveCSS("animation-name", "none");
    await page.evaluate(() => (window as unknown as BootTestWindow).__vorteoFinishBoot());
    await expect(overlay).toHaveCount(0);
  },
);
