import { test, expect } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  seedRunningMockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { delayAgentBootstrapTailResponse } from "../support/helpers/agent-timeline-gate";

for (const width of [390, 1133]) {
  test(`shaded loader stays centered during view loading at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 744 });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "shaded-loader-",
      title: "Loader check",
      initialPrompt: "Hello",
    });
    const gate = await delayAgentBootstrapTailResponse(page, session.agentId);
    try {
      await openAgentRoute(page, session);
      const mark = page.getByTestId("loading-brand-mark").first();
      await expect(mark).toBeVisible();
      const before = await mark.boundingBox();
      const image = mark.locator("img");
      await expect
        .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      expect(await image.evaluate((node) => getComputedStyle(node).filter)).toBe("none");
      const ring = mark.locator("..").locator("svg");
      expect(before!.width).toBeCloseTo(43.2, 1);
      expect(await ring.locator("stop").last().getAttribute("stop-opacity")).toBe("1");
      expect(await ring.locator("stop").first().getAttribute("stop-opacity")).toBe("0.07");
      const bounds = (await ring.boundingBox())!;
      expect(await ring.evaluate((node) => parseFloat(getComputedStyle(node).width))).toBe(60);
      expect(Math.abs(before!.x + before!.width / 2 - bounds.x - bounds.width / 2)).toBeLessThan(1);
      expect(Math.abs(before!.y + before!.height / 2 - bounds.y - bounds.height / 2)).toBeLessThan(
        1,
      );
      await page.waitForTimeout(250);
      expect(await mark.boundingBox()).toEqual(before);
      await page.screenshot({ path: info.outputPath(`medium-loader-${width}.png`) });
      gate.release();
      gate.releaseCatchUp();
      await expect(mark).not.toBeVisible();
      await expect(page.getByTestId("agent-chat-scroll")).toBeVisible();
    } catch (error) {
      await page.screenshot({ path: info.outputPath("before-cleanup.png") });
      throw error;
    } finally {
      gate.release();
      gate.releaseCatchUp();
      await session.cleanup();
    }
  });
}

test("sidebar running dots keep a bright leading edge and dim radar tail", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = await seedRunningMockAgentWorkspace({
    repoPrefix: "radar-sidebar-",
    title: "Radar sidebar check",
    model: "five-minute-stream",
    initialPrompt: "Stay active for the ring check",
  });
  try {
    await openAgentRoute(page, session);
    const ring = page.getByTestId("agent-running-spinner").filter({ visible: true }).first();
    await expect(ring).toBeVisible();
    expect(Number(await ring.locator("stop").first().getAttribute("stop-opacity"))).toBeCloseTo(
      0.063,
    );
    await expect(ring.locator("stop").last()).toHaveAttribute("stop-opacity", "0.9");
    await expect(ring.locator("path")).toHaveAttribute("stroke", /^url\(#radar-/);
    const diameter = await ring
      .locator("svg")
      .evaluate((node) => Number(node.getAttribute("width")));
    expect(diameter).toBeLessThan(20);
    await page.screenshot({ path: info.outputPath("sidebar-radar.png") });
  } finally {
    await session.cleanup();
  }
});

for (const theme of ["starship-light", "starship-dark", "scriptorium", "midas", "ember", "neon"]) {
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
      if (theme.startsWith("starship")) {
        await expect(mark.locator("img")).toHaveAttribute(
          "src",
          new RegExp(theme === "starship-light" ? "vorteo-color" : "vorteo-white"),
        );
      } else {
        await expect(mark.locator("svg path")).toHaveAttribute("fill", /^url\(#vorteo-/);
        expect(await mark.locator("stop").count()).toBe(2);
      }
      await page.screenshot({ path: info.outputPath(`logo-${theme}.png`) });
      const brand = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("vorteo-boot-brand-v1")!),
      );
      let expectedMode = "gradient";
      if (theme === "starship-light") expectedMode = "rainbow";
      if (theme === "starship-dark") expectedMode = "white";
      expect(brand.mode).toBe(expectedMode);
      await page.route("**/_expo/static/js/web/*.js", (route) => route.abort());
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#boot-status")).toBeVisible();
      if (brand.mode === "gradient") {
        await expect(page.locator("#boot-tinted-mark")).toBeVisible();
        await expect(page.locator("img.boot-mark")).toBeHidden();
      } else {
        await expect(page.locator("img.boot-mark")).toBeVisible();
        if (brand.mode === "rainbow")
          await expect(page.locator("img.boot-mark")).toHaveAttribute("src", /vorteo-logo-color/);
      }
      await page.screenshot({ path: info.outputPath(`startup-logo-${theme}.png`) });
    } finally {
      gate.release();
      gate.releaseCatchUp();
      await session.cleanup();
    }
  });
}
