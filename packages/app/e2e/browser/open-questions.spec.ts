import { randomUUID } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.use({ e2eInjectPaseoTools: true });

/** The daemon refuses one answer exactly as it would for a stale or withdrawn question. */
async function rejectNextAnswer(page: Page): Promise<void> {
  let rejected = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      const request = frame?.message;
      if (!rejected && request?.type === "agent.questions.answer.request") {
        rejected = true;
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "agent.questions.answer.response",
              payload: {
                agentId: request.agentId,
                requestId: request.requestId,
                questions: null,
                error: "The agent withdrew this question; it no longer needs an answer.",
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

for (const [label, width] of [
  ["phone", 390],
  ["tablet", 820],
  ["desktop", 1400],
] as const) {
  test(`owner answers open questions inline at ${label} width`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "open-questions-",
      title: "Beta launch",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "open-questions" });
    const mcp = new McpClient({ name: "open-questions-test", version: "1.0.0" });
    try {
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "create",
        id: "provision",
        text: "Provision the beta region",
      });
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents?callerAgentId=${agent.agentId}`,
          ),
        ),
      );
      const region = randomUUID();
      const notes = randomUUID();
      for (const mutation of [
        {
          operation: "ask",
          id: region,
          question: "Which region should the beta use?",
          why: "Provisioning cannot start until the region is chosen, and moving later costs a migration.",
          recommendedDefault: "us-east-1, closest to most testers",
          blocks: ["provision"],
          defaultAppliesAfter: new Date(Date.now() + 8 * 3600_000).toISOString(),
        },
        {
          operation: "ask",
          id: notes,
          question: "Should release notes mention the pricing change?",
          why: "The notes are drafted; pricing copy needs your call.",
          recommendedDefault: "Mention it in one sentence",
        },
      ])
        expect(
          (await mcp.callTool({ name: "update_questions", arguments: { mutation } })).isError,
        ).not.toBe(true);

      await rejectNextAnswer(page);
      await openAgentRoute(page, agent);
      const card = page.getByTestId("open-questions-card");
      await expect(card).toBeVisible();
      await expect(page.getByTestId("open-questions-count")).toHaveText("2");
      const first = page.getByTestId(`open-question-${region}`);
      await expect(first.getByText("Which region should the beta use?")).toBeVisible();
      await expect(first.getByText(/Recommended default applies after/)).toBeVisible();
      await expect(page.getByTestId("open-question-task-provision")).toHaveText(
        "Provision the beta region",
      );
      if (width === 1400)
        await expect(page.locator('[data-testid^="workspace-open-questions-"]')).toHaveText("2");
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`open-questions-${label}.png`) });

      await page.getByTestId(`open-question-use-recommended-${region}`).click();
      await expect(first.getByRole("alert")).toHaveText(
        "The agent withdrew this question; it no longer needs an answer.",
      );
      await expect(page.getByTestId("open-questions-count")).toHaveText("2");
      await page.getByTestId(`open-question-use-recommended-${region}`).click();
      await expect(first).not.toBeAttached();
      await expect(page.getByTestId("open-questions-count")).toHaveText("1");

      await page.getByTestId(`open-question-answer-${notes}`).fill("Leave pricing out for now");
      await page.getByTestId(`open-question-send-${notes}`).click();
      await expect(page.getByTestId(`open-question-${notes}`)).not.toBeAttached();
      await expect(card.getByText("No questions are waiting for you.")).toBeVisible();
      await expect(page.getByTestId("open-questions-count")).not.toBeAttached();
      await expect(page.locator('[data-testid^="workspace-open-questions-"]')).toHaveCount(0);
      await page.getByTestId("open-questions-answered-toggle").click();
      await expect(page.getByTestId(`answered-question-${notes}`)).toContainText(
        "Leave pricing out for now",
      );
      await expect(
        page.getByText(
          'Owner answered "Which region should the beta use?": us-east-1, closest to most testers',
        ),
      ).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`open-questions-answered-${label}.png`) });

      const questions = await client.answerAgentQuestion(
        agent.agentId,
        notes,
        "Leave pricing out for now",
      );
      expect(questions.map((item) => item.status)).toEqual(["answered", "answered"]);
      await expect
        .poll(async () => {
          const timeline = await client.fetchAgentTimeline(agent.agentId);
          return timeline.entries.filter(
            (entry) =>
              entry.item.type === "user_message" &&
              entry.item.text.includes("The owner answered your open question."),
          ).length;
        })
        .toBe(2);
    } finally {
      await mcp.close();
      await client.close();
      await agent.cleanup();
    }
  });
}
