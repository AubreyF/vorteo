import { test, expect } from "../support/fixtures";
import { seedRunningMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { expectComposerVisible } from "../support/helpers/composer";

test("an unknown host still redirects after the startup registry loads", async ({ page }) => {
  await page.goto("/h/unknown-startup-host/workspace/missing-workspace");
  await expect(page).toHaveURL(/\/open-project$/);
});

for (const width of [1440, 900, 390]) {
  test(`host startup retains the content column position at ${width}px`, async ({ page }) => {
    const agent = await seedRunningMockAgentWorkspace({
      repoPrefix: "startup-shell-",
      title: "Startup shell",
      model: "ten-second-stream",
      initialPrompt: "Populate the workspace",
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        const movements: number[] = [];
        Reflect.set(window, "__startupColumnMovements", movements);
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & {
              hadRecentInput: boolean;
              sources: Array<{ previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
            };
            if (shift.hadRecentInput) continue;
            for (const source of shift.sources) {
              const isContentColumn =
                source.previousRect.height >= innerHeight * 0.8 &&
                source.currentRect.height >= innerHeight * 0.8;
              if (isContentColumn) {
                movements.push(Math.abs(source.currentRect.x - source.previousRect.x));
              }
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      for (let load = 0; load < 2; load++) {
        if (load === 0) await openAgentRoute(page, agent);
        else await page.reload();
        await expectComposerVisible(page);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<number>((resolve) => requestAnimationFrame(resolve));
          await new Promise<number>((resolve) => requestAnimationFrame(resolve));
        });
        const movements: number[] = await page.evaluate(() =>
          Reflect.get(window, "__startupColumnMovements"),
        );
        expect(
          Math.max(0, ...movements),
          "hydrating hosts must not insert a sidebar beside painted content",
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      await agent.cleanup();
    }
  });
}
