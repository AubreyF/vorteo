import { randomUUID } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";

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

      await expect(page.getByTestId(`answered-question-${notes}`)).toContainText(
        "from the Vorteo app",
      );
      // Tools and bridges share the daemon credential but cannot answer for the owner.
      await expect(
        client.answerAgentQuestion(agent.agentId, notes, "Leave pricing out for now"),
      ).rejects.toThrow("Answer open questions from the Vorteo app.");
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

for (const [label, width, height] of [
  ["phone", 390, 700],
  ["desktop", 1400, 900],
] as const) {
  test(`owner answers every thread's questions from the sidebar at ${label} width`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const first = await seedMockAgentWorkspace({
      repoPrefix: "global-questions-a-",
      title: "Beta launch",
    });
    const second = await seedMockAgentWorkspace({
      repoPrefix: "global-questions-b-",
      title: "Pricing page",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "global-questions" });
    const tools: McpClient[] = [];
    try {
      const asks = [
        { agent: first, id: randomUUID(), question: "Which region should the beta use?" },
        { agent: second, id: randomUUID(), question: "Should the pricing page show annual plans?" },
      ];
      for (const ask of asks) {
        const mcp = new McpClient({ name: "global-questions-test", version: "1.0.0" });
        tools.push(mcp);
        await mcp.connect(
          new StreamableHTTPClientTransport(
            new URL(
              `http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents?callerAgentId=${ask.agent.agentId}`,
            ),
          ),
        );
        const mutation = {
          operation: "ask",
          id: ask.id,
          question: ask.question,
          why: "Work cannot continue until you decide.",
          recommendedDefault: "Use the recommended option",
        };
        expect(
          (await mcp.callTool({ name: "update_questions", arguments: { mutation } })).isError,
        ).not.toBe(true);
      }

      await openAgentRoute(page, first);
      if (width < 768) await openMobileAgentSidebar(page);
      const card = page.getByTestId("global-open-questions-card");
      await expect(card).toBeVisible();
      await expect(page.getByTestId("global-open-questions-card-count")).toHaveText("2");
      // Short screens show one open card at a time; the questions card wins over Quota.
      await expect(page.getByTestId("global-quota-card")).toBeVisible();
      await expect(page.getByTestId("global-quota-card-body-scroll")).toHaveCount(
        height < 720 ? 0 : 1,
      );
      for (const ask of asks) {
        const group = page.getByTestId(`global-open-questions-thread-${ask.agent.agentId}`);
        await expect(group.getByText(ask.question)).toBeVisible();
      }
      await expect(
        page
          .getByTestId(`global-open-questions-thread-${second.agentId}`)
          .getByText("Pricing page", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath(`global-open-questions-${label}.png`) });

      // Answering from the sidebar reaches the thread that asked, not the open one.
      await page.getByTestId(`global-open-question-use-recommended-${asks[1]!.id}`).click();
      await expect(
        page.getByTestId(`global-open-questions-thread-${second.agentId}`),
      ).not.toBeAttached();
      await expect(page.getByTestId("global-open-questions-card-count")).toHaveText("1");
      await expect
        .poll(async () => {
          const timeline = await client.fetchAgentTimeline(second.agentId);
          return timeline.entries.some(
            (entry) =>
              entry.item.type === "user_message" &&
              entry.item.text.includes("Should the pricing page show annual plans?"),
          );
        })
        .toBe(true);

      // The card collapses to its heading and remembers that across a reload.
      await page.getByTestId("global-open-questions-card-toggle").click();
      await expect(page.getByTestId(`global-open-question-${asks[0]!.id}`)).not.toBeAttached();
      await page.reload();
      if (width < 768) await openMobileAgentSidebar(page);
      await expect(page.getByTestId("global-open-questions-card")).toBeVisible();
      await expect(page.getByTestId(`global-open-question-${asks[0]!.id}`)).not.toBeAttached();
      await page.getByTestId("global-open-questions-card-toggle").click();

      await page.getByTestId(`global-open-question-use-recommended-${asks[0]!.id}`).click();
      await expect(page.getByTestId("global-open-questions-card")).not.toBeAttached();
    } finally {
      for (const mcp of tools) await mcp.close();
      await client.close();
      await first.cleanup();
      await second.cleanup();
    }
  });
}
