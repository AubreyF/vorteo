import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

function expandQuestion(raw: string | Buffer) {
  return JSON.stringify(
    JSON.parse(raw.toString(), (_key, value) => {
      if (value?.question !== "Which surface should this apply to?" || !value.options) return value;
      return {
        ...value,
        options: value.options.map((option: { label: string }) => ({
          ...option,
          description:
            "Consider the navigation, answer controls and readable content on this surface. ".repeat(
              24,
            ),
        })),
      };
    }),
  );
}

for (const width of [390, 1280]) {
  test(`long question cards scroll with the conversation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 650 });
    await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
      const server = socket.connectToServer();
      server.onMessage((raw) => {
        socket.send(expandQuestion(raw));
      });
    });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "question-content-scroll-",
      title: "Long question scrolling",
      initialPrompt: "Emit synthetic questions.",
    });
    try {
      await openAgentRoute(page, session);
      const setupNotice = page
        .getByTestId("installation-update-toasts")
        .filter({ hasText: "Set up worktree scripts" });
      const card = page.getByTestId("question-form-card");
      await expect(card).toContainText("Consider the navigation");
      await expect(setupNotice).toBeVisible();
      await setupNotice.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect(card.getByTestId("question-form-card-body-scroll")).toHaveCount(0);
      await expect.poll(async () => (await card.boundingBox())!.height).toBeGreaterThan(650);
      const scrollers = await card.evaluate(
        (node) =>
          [...node.querySelectorAll("*")].filter(
            (child) =>
              /auto|scroll/.test(getComputedStyle(child).overflowY) &&
              child.scrollHeight > child.clientHeight + 1,
          ).length,
      );
      expect(scrollers).toBe(0);
      const lastOption = card.getByRole("radio").last();
      await lastOption.scrollIntoViewIfNeeded();
      await expect(lastOption).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`question-page-scroll-${width}.png`) });
      await lastOption.click();
      await expect(card).toContainText("Which rollout should we use?");
      await card.getByRole("radio", { name: "Behind feature flag", exact: true }).click();
      await expect(card).toContainText("What success criteria should we use?");
      await card.getByRole("textbox").fill("Answers remain reachable without nested scrolling.");
      await card.getByTestId("question-form-primary-action").click();
      await expect(card).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });
}
