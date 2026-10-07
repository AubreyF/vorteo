import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { expect, test, type Page } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

test("agents, tasks, plugin pills, queue and goals share the scrolling footer", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "scrolling-cards-",
    title: "Scrolling card parent",
    initialPrompt: "emit 2 agent stream updates",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "scrolling-cards" });
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "scrolling-cards-plugin-"));
  const pluginId = "scrolling-cards-test";
  const previous = await client.getDaemonConfig();
  try {
    const childIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const child = await agent.client.createAgent({
        provider: "mock",
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        title: `Card child ${i}`,
        modeId: "load-test",
        model: "e2e-fast-stream",
        labels: { [PARENT_AGENT_ID_LABEL]: agent.agentId },
      });
      childIds.push(child.id);
    }
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      expectedRevision: 0,
      operationId: "pause-cards",
    });
    await client.mutateMessageQueue(agent.agentId, {
      kind: "enqueue",
      operationId: "enqueue-cards",
      messageId: "card-message",
      text: "Queued after progress",
      attachments: [],
    });
    // The mock provider has no goals. Supply only that provider-owned observation;
    // agents, todo events, plugin registration and queue operations use the real daemon.
    const goalState = {
      status: "ready",
      observedAt: new Date().toISOString(),
      goal: {
        threadId: agent.agentId,
        objective: "Goal below queued messages",
        status: "paused",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    await mockGoalObservation(page, agent.agentId, goalState);
    await writeFile(
      path.join(pluginDirectory, "paseo-plugin.json"),
      JSON.stringify({ id: pluginId, requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(pluginDirectory, "index.client.tsx"),
      `export default function contribute(client) {
  const registration = client.addComposerPill({
    id: "scroll",
    workspaceId: ${JSON.stringify(agent.workspaceId)},
    agentId: ${JSON.stringify(agent.agentId)},
    button: {
      title: "Scrolling plugin action",
      label: "Plugin pill",
      icon: "Sparkles",
      behavior: { kind: "action", onPress: () => registration.remove() },
    },
  });
  return () => registration.remove();
}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    await openAgentRoute(page, agent);
    const stack = page.getByTestId("agent-history-task-cards");
    const ids = [
      "subagents-card",
      "agent-task-progress-card",
      "shared-message-queue",
      "agent-goal-bar",
    ];
    for (const id of ids) await expect(stack.getByTestId(id)).toBeAttached();
    const pill = page.getByRole("button", { name: "Scrolling plugin action", exact: true });
    await expect(stack.getByTestId("agent-history-plugin-pills")).toContainText("Plugin pill");
    await expect(page.getByTestId("subagents-track-header")).toHaveCount(0);
    await expect(page.getByTestId("agent-task-list-header")).toHaveCount(0);
    await expect(stack).toContainText("stress-update-1");
    await expect(stack).toContainText("Queued after progress");

    await agent.client.sendAgentMessage(agent.agentId, "Emit synthetic questions.");
    await expect(stack.getByTestId("question-form-card")).toBeAttached();

    for (const width of [1400, 390]) {
      await page.setViewportSize({ width, height: 650 });
      if (width === 390) {
        const actions = stack.getByTestId(/^subagents-track-(archive|detach)-/);
        for (const action of await actions.all()) {
          await expect
            .poll(async () => (await action.boundingBox())?.height)
            .toBeGreaterThanOrEqual(44);
        }
      }
      const geometry = await stack.evaluate((element, cardIds) => {
        const selectors = ["question-form-card", "agent-history-plugin-pills", ...cardIds];
        return selectors.map((id) => {
          const node = element.querySelector(`[data-testid="${id}"]`)!;
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            id,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
            padding: style.padding,
            frame: [
              style.backgroundColor,
              style.borderColor,
              style.borderWidth,
              style.borderRadius,
            ],
          };
        });
      }, ids);
      for (let i = 1; i < geometry.length; i++)
        expect(geometry[i].top - geometry[i - 1].bottom).toBeCloseTo(16, 0);
      expect(geometry[0].frame[3]).toBe("8px");
      expect(geometry[2].padding).toBe("0px 8px 8px");
      for (const card of geometry.slice(2)) {
        expect(card.frame).toEqual(geometry[0].frame);
      }
      const toggle = stack.getByTestId("subagents-card-toggle");
      const headerHeight = await toggle.evaluate((node) => node.getBoundingClientRect().height);
      const rowHeight = await stack.getByTestId("subagents-card").evaluate((card) => {
        const row = card.lastElementChild?.firstElementChild;
        if (!row) throw new Error("Subagent row missing");
        return row.getBoundingClientRect().height;
      });
      expect(headerHeight).toBe(rowHeight);
      if (width === 1400) {
        await toggle.hover();
        expect((await toggle.boundingBox())?.height).toBe(headerHeight);
      }
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect((await toggle.boundingBox())?.height).toBe(headerHeight);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const subagentBottomInset = await stack.getByTestId("subagents-card").evaluate((card) => {
        const rows = card.lastElementChild;
        const lastRow = rows?.lastElementChild;
        if (!lastRow) throw new Error("Subagent rows missing");
        return card.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom;
      });
      expect(subagentBottomInset).toBeCloseTo(9, 0);
      if (width === 1400) {
        const composerFrame = await page.getByTestId("message-input-surface").evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.backgroundColor, style.borderColor, style.borderWidth, style.borderRadius];
        });
        expect(composerFrame).toEqual(geometry[0].frame);
      }
      for (const card of geometry.slice(3)) {
        expect(card.frame).toEqual(geometry[2].frame);
        expect(card.padding).toBe(width === 390 ? "0px 8px 8px 12px" : "0px 8px 8px 16px");
        expect(card.width).toBe(geometry[2].width);
      }
      const movement = await stack.evaluate(async (element) => {
        let scroll = element.parentElement;
        while (
          scroll &&
          !(
            scroll.scrollHeight > scroll.clientHeight + 30 &&
            /auto|scroll/.test(getComputedStyle(scroll).overflowY)
          )
        )
          scroll = scroll.parentElement;
        if (!scroll) throw new Error("Cards have no scrollable conversation ancestor");
        scroll.scrollTop = 0;
        await new Promise(requestAnimationFrame);
        const before = element.getBoundingClientRect().top;
        scroll.scrollTop = scroll.scrollHeight;
        await new Promise(requestAnimationFrame);
        return before - element.getBoundingClientRect().top;
      });
      expect(movement).toBeGreaterThan(30);
      await expect
        .poll(async () => {
          const goal = await page.getByTestId("agent-goal-bar").boundingBox();
          const composer = await page.getByTestId("message-input-root").boundingBox();
          if (!goal || !composer) throw new Error("Goal or composer missing");
          return Math.round(composer.y - goal.y - goal.height);
        })
        .toBe(16);
      await info.attach(`scrolling-cards-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(stack.getByTestId("subagents-card")).toBeAttached();
    await pill.click();
    await expect(pill).toHaveCount(0);
    await stack.getByRole("button", { name: "Card child 0", exact: true }).click();
    await expectAgentTabActive(page, childIds[0]);
    await expect(
      page.getByText("Queued after progress", { exact: true }).filter({ visible: true }),
    ).toHaveCount(0);
  } finally {
    await client.removePlugin(pluginId).catch(() => {});
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await agent.cleanup();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

async function mockGoalObservation(page: Page, agentId: string, goalState: unknown) {
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const envelope = JSON.parse(raw.toString());
      if (envelope.message?.type === "agent.goal.get.request") {
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "agent.goal.get.response",
              payload: {
                agentId: agentId,
                requestId: envelope.message.requestId,
                state: goalState,
                error: null,
              },
            },
          }),
        );
      } else server.send(raw);
    });
    server.onMessage((raw) => {
      const envelope = JSON.parse(raw.toString(), (_key, value) => {
        if (value?.id === agentId && value.capabilities) {
          return {
            ...value,
            capabilities: { ...value.capabilities, supportsGoals: true },
            goalState,
          };
        }
        return value;
      });
      socket.send(JSON.stringify(envelope));
    });
  });
}
