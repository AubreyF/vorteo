import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  requestDiagram,
  waitForDiagramTurnToComplete,
  expectCompletedDiagram,
  expectFullscreenDiagram,
  expectFullscreenDiagramClosed,
} from "../support/helpers/diagram";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

test("diagram controls support touch without first hovering or touching the canvas", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "touch-diagram-",
    title: "Touch diagram",
    featureValues: {
      mockStreamingAssistantResponse: "```mermaid\nflowchart LR\n Start --> Ship\n```",
      mockStreamingAssistantIntervalMs: 10,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await requestDiagram(agent);
    await waitForDiagramTurnToComplete(agent);
    await expectCompletedDiagram(page, ["Start", "Ship"]);
    const open = page.getByTestId("mermaid-fullscreen").last();
    await expect(open).toHaveCSS("opacity", "1");
    const bounds = await open.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await open.tap();
    await expectFullscreenDiagram(page, ["Start", "Ship"]);
    await page.getByTestId("mermaid-fullscreen-close").tap();
    await expectFullscreenDiagramClosed(page);
    await expectCompletedDiagram(page, ["Start", "Ship"]);
  } finally {
    await agent.cleanup();
  }
});
