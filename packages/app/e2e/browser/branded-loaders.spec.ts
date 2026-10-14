import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
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
      const bounds = (await ring.boundingBox())!;
      expect(await ring.evaluate((node) => parseFloat(getComputedStyle(node).width))).toBe(48);
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
