import { expect, test } from "../support/fixtures";
import { waitForPermissionPrompt } from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// The plan card has to pass its own markdown parser. Drop that prop and
// react-native-markdown-display silently supplies one with `typographer: true`
// (node_modules/react-native-markdown-display/src/index.js:139-141), which
// turns (c) into ©, curls straight quotes, and rewrites --- as an em dash.
// No unit test can catch that, because the defect lives in the JSX.
//
// Nothing here is provider-specific: the mock provider drives it, and the
// behavior is the same for every agent.
test.describe("Plan card markdown", () => {
  test("renders plan text verbatim", async ({ page }, info) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "plan-card-markdown-",
      title: "Plan card markdown e2e",
      initialPrompt: "Emit synthetic plan approval.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForPermissionPrompt(page, 120_000);

      const planCard = page.getByTestId("permission-plan-card");
      await expect(planCard).toContainText("(c)");
      await expect(planCard).toContainText('--name="my repo"');
      await expect(planCard).toContainText("---buzz");
      await expect(planCard).not.toContainText("©");
      await expect(planCard).not.toContainText("—buzz");
      for (const width of [1400, 390]) {
        await page.setViewportSize({ width, height: 400 });
        await planCard.scrollIntoViewIfNeeded();
        const header = page.getByTestId("permission-plan-card-header");
        const height = (await header.boundingBox())!.height;
        const disclosure = page.getByTestId("permission-plan-card-toggle");
        const arrow = page.getByTestId("permission-plan-card-toggle-arrow");
        const order = await arrow.evaluate((node) => ({
          arrow: node.getBoundingClientRect().x,
          title: node.previousElementSibling!.getBoundingClientRect().right,
        }));
        expect(order.arrow).toBeGreaterThan(order.title);
        expect(height).toBe(width === 390 ? 44 : 32);
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        await planCard.scrollIntoViewIfNeeded();
        const before = (await header.boundingBox())!.y - (await planCard.boundingBox())!.y;
        const scrolled = await page
          .getByTestId("permission-plan-card-body-scroll")
          .evaluate(async (node) => {
            node.scrollTop = node.scrollHeight;
            await new Promise(requestAnimationFrame);
            return node.scrollTop;
          });
        expect((await planCard.boundingBox())!.height).toBeLessThanOrEqual(200);
        expect(scrolled).toBeGreaterThan(0);
        expect((await header.boundingBox())!.y - (await planCard.boundingBox())!.y).toBeCloseTo(
          before,
          0,
        );
      }
      await page.setViewportSize({ width: 1400, height: 1200 });
      await page.getByTestId("permission-plan-card-body-scroll").evaluate((node) => {
        node.scrollTop = 0;
      });
      await planCard.screenshot({ path: info.outputPath("consistent-plan-card.png") });
    } finally {
      await session.cleanup();
    }
  });
});
