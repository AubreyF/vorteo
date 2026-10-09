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
            padding: getComputedStyle(node.firstElementChild!).padding,
            frame: [
              style.backgroundColor,
              style.borderColor,
              style.borderWidth,
              style.borderRadius,
            ],
          };
        });
      }, ids);
      for (const card of geometry) expect(card.bottom - card.top).toBeLessThanOrEqual(325);
      for (let i = 1; i < geometry.length; i++)
        expect(geometry[i].top - geometry[i - 1].bottom).toBeCloseTo(16, 0);
      expect(geometry[0].frame[3]).toBe("8px");
      expect(geometry[2].padding).toBe("8px");
      for (const card of geometry.slice(2)) {
        expect(card.frame).toEqual(geometry[0].frame);
      }
      const toggle = stack.getByTestId("subagents-group-paseo-toggle");
      const headerHeight = await toggle.evaluate((node) => node.getBoundingClientRect().height);
      const rowHeight = await stack.getByTestId("subagents-card").evaluate((card) => {
        const row = card.querySelector('[data-testid="subagents-group-paseo"]')?.firstElementChild;
        if (!row) throw new Error("Subagent header row missing");
        return row.getBoundingClientRect().height;
      });
      expect(headerHeight).toBe(rowHeight - 8);
      const clearFinished = stack.getByTestId("subagents-track-archive-finished");
      await expect(clearFinished).toBeVisible();
      expect((await clearFinished.boundingBox())?.height).toBe(headerHeight);
      expect(headerHeight).toBe(width === 390 ? 44 : 32);
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
        const rows = card.querySelectorAll('[data-testid^="subagents-track-row-"]');
        const lastRow = rows.item(rows.length - 1);
        if (!lastRow) throw new Error("Subagent rows missing");
        return (
          card.firstElementChild!.getBoundingClientRect().bottom -
          lastRow.getBoundingClientRect().bottom
        );
      });
      expect(subagentBottomInset).toBeCloseTo(8, 0);
      if (width === 1400) {
        const composerFrame = await page.getByTestId("message-input-surface").evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.backgroundColor, style.borderColor, style.borderWidth, style.borderRadius];
        });
        expect(composerFrame).toEqual(geometry[0].frame);
      }
      for (const card of geometry.slice(3)) {
        expect(card.frame).toEqual(geometry[2].frame);
        const bottomPadding = card.id === "agent-goal-bar" ? 16 : 8;
        const leftPadding = width === 390 ? 12 : 16;
        expect(card.padding).toBe(`8px 8px ${bottomPadding}px ${leftPadding}px`);
        expect(card.width).toBe(geometry[2].width);
      }
      const goalActionInset = await stack.getByTestId("agent-goal-bar").evaluate((card) => {
        const header = card.firstElementChild?.firstElementChild;
        const action = card.querySelector('[data-testid="agent-goal-clear"]');
        if (!header || !action) throw new Error("Goal controls missing");
        return action.getBoundingClientRect().top - header.getBoundingClientRect().top;
      });
      expect(goalActionInset).toBe(8);
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

test("workspace checklist flower combines unopened threads and survives reload", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "checklist-progress-",
    title: "Checklist parent",
    initialPrompt: "emit 2 agent stream updates",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "checklist-progress" });
  try {
    const sibling = await client.createAgent({
      provider: "mock",
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      title: "Unopened checklist thread",
      modeId: "load-test",
      model: "e2e-fast-stream",
      initialPrompt: "emit 1 agent stream updates",
    });
    await openAgentRoute(page, agent);
    const card = page.getByTestId("agent-task-progress-card");
    const ring = page.getByTestId(/^workspace-task-progress-/);
    await expect(card.getByTestId("checklist-count")).toHaveText("0/1");
    await expect(card).toContainText("stress-update-1");
    await expect(ring).toHaveAttribute("aria-valuenow", "1");
    await expect(ring).toHaveAttribute("aria-valuemax", "2");
    await expect(ring).toHaveAttribute("aria-label", /1\/2 tasks \(50%\).*active/);
    await client.sendAgentMessage(sibling.id, "emit 2 agent stream updates");
    await expect(ring).toHaveAttribute("aria-valuenow", "0");
    await page.reload();
    await expect(card.getByTestId("checklist-count")).toHaveText("0/1");
    await expect(ring).toHaveAttribute("aria-label", /0\/2 tasks \(0%\).*active/);
    await client.archiveAgent(sibling.id);
    await expect(ring).toHaveAttribute("aria-valuemax", "1");
    await client.sendAgentMessage(agent.agentId, "emit 1 agent stream updates");
    await expect(card.getByTestId("checklist-count")).toHaveText("1/1");
    await expect(ring).toHaveAttribute("aria-label", /1\/1 tasks \(100%\).*active/);
    for (const width of [1400, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(card).toBeAttached();
      await info.attach(`checklist-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
  } finally {
    await client.close();
    await agent.cleanup();
  }
});

for (const width of [1400, 390]) {
  test(`manual checklist controls preserve drafts and report conflicts at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "manual-checklist-",
      title: "Manual checklist",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "manual-checklist" });
    try {
      await openAgentRoute(page, agent);
      const expectCenteredHeader = async () => {
        const clearance = await page.getByTestId("agent-task-progress-card").evaluate((card) => {
          const box = card.getBoundingClientRect();
          const header = card.firstElementChild!.firstElementChild!.getBoundingClientRect();
          return { top: header.top - box.top, bottom: box.bottom - header.bottom };
        });
        expect(clearance.top).toBeCloseTo(clearance.bottom, 0);
      };
      await expect(page.getByTestId("agent-task-progress-card")).not.toBeAttached();
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "create",
        id: "first",
        text: "First agent-created task",
      });
      await expect(page.getByTestId("checklist-count")).toHaveText("0/1");
      const single = page
        .getByTestId("checklist-progress")
        .locator("svg path[fill]:not([fill='none'])");
      await expect(single).toHaveCount(1);
      const bounds = await single.evaluate((node) => {
        const box = (node as SVGGraphicsElement).getBBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      expect(bounds.x).toBeCloseTo(12, 1);
      expect(bounds.y).toBeCloseTo(12, 1);
      await client.mutateAgentChecklist(agent.agentId, { operation: "delete", id: "first" });
      await expect(page.getByTestId("agent-task-progress-card")).not.toBeAttached();
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "create",
        id: "seed",
        text: "Agent task",
      });
      await page.getByTestId("checklist-add").click();
      await page.getByTestId("checklist-title").fill("Build API");
      await page.getByTestId("checklist-description").fill("Updates survive reload");
      await page.getByTestId("checklist-save").click();
      await expect(page.getByTestId("checklist-editor")).not.toBeAttached();
      await client.mutateAgentChecklist(agent.agentId, { operation: "delete", id: "seed" });
      const tasks = await client.getAgentChecklist(agent.agentId);
      const api = tasks.find((task) => task.text === "Build API");
      expect(api).toMatchObject({
        id: expect.any(String),
        text: "Build API",
        description: "Updates survive reload",
      });
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "create",
        id: "dependent",
        text: "Build card",
        blockedBy: [api!.id!],
      });
      await page.getByRole("checkbox", { name: "Complete Build card", exact: true }).click();
      await expect(
        page.getByTestId("agent-task-progress-card").getByRole("alert").first(),
      ).toContainText("Complete dependency");
      await page.getByRole("checkbox", { name: "Complete Build API", exact: true }).click();
      await page.getByRole("checkbox", { name: "Complete Build card", exact: true }).click();
      await expect(page.getByTestId("checklist-count")).toHaveText("2/2");
      await page.getByRole("button", { name: "Details for Build API", exact: true }).click();
      await page.getByTestId("checklist-title").fill("My retained draft");
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "update",
        id: api!.id!,
        text: "Agent revision",
      });
      await page.getByTestId("checklist-save").click();
      await expect(page.getByTestId("checklist-editor").getByRole("alert")).toContainText(
        "changed while you were editing",
      );
      await expect(page.getByTestId("checklist-title")).toHaveValue("My retained draft");
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
      await page.getByRole("checkbox", { name: "Reopen Agent revision", exact: true }).click();
      await expect(page.getByTestId("checklist-count")).toHaveText("1/2");
      await page.reload();
      await expect(
        page.getByRole("checkbox", { name: "Complete Agent revision", exact: true }),
      ).toBeVisible();
      const handle = page.getByTestId("checklist-drag-dependent");
      const checkbox = page.getByTestId("checklist-row-dependent").getByRole("checkbox");
      expect((await handle.boundingBox())!.x).toBeLessThan((await checkbox.boundingBox())!.x);
      await handle.click();
      await expect(handle).toBeFocused();
      await handle.press("Space");
      await expect(handle).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("ArrowUp");
      await expect(
        page.getByRole("status").filter({ hasText: "Draggable item vorteo:dependent" }),
      ).toContainText(`over droppable area vorteo:${api!.id!}`);
      await page.keyboard.press("Space");
      await expect
        .poll(async () => (await client.getAgentChecklist(agent.agentId)).map((task) => task.id))
        .toEqual(["dependent", api!.id!]);
      await page.getByRole("button", { name: "Details for Build card", exact: true }).click();
      await page.getByRole("textbox", { name: "Task owner", exact: true }).fill("Reviewer");
      await page.getByRole("button", { name: "Pending", exact: true }).click();
      await page
        .getByTestId("checklist-editor")
        .getByRole("button", { name: "✓ Agent revision", exact: true })
        .click();
      await page.getByTestId("checklist-save").click();
      await expect(page.getByTestId("checklist-editor")).not.toBeAttached();
      expect(
        (await client.getAgentChecklist(agent.agentId)).find((task) => task.id === "dependent")
          ?.owner,
      ).toBe("Reviewer");
      await page.getByTestId("checklist-toggle").click();
      await expect(page.getByTestId("checklist-row-dependent")).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("0/2");
      await expectCenteredHeader();
      await page.getByTestId("checklist-toggle").click();
      await page.getByRole("checkbox", { name: "Complete Build card", exact: true }).click();
      await info.attach(`manual-checklist-${width}`, {
        body: await page.screenshot({ path: info.outputPath("manual-checklist.png") }),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "Details for Build card", exact: true }).click();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Delete task", exact: true }).click();
      await expect(page.getByTestId("checklist-editor")).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("0/1");
      expect((await client.getAgentChecklist(agent.agentId)).map((task) => task.id)).toEqual([
        api!.id!,
      ]);
      for (let index = 0; index < 16; index++) {
        await client.mutateAgentChecklist(agent.agentId, {
          operation: "create",
          id: `scroll-${index}`,
          text: `Task ${index}`,
        });
      }
      const card = page.getByTestId("agent-task-progress-card");
      const lastTask = page.getByTestId("checklist-row-scroll-15");
      await expect(lastTask).toBeAttached();
      await expect(
        page.getByTestId("checklist-progress").locator("svg path[fill]:not([fill='none'])"),
      ).toHaveCount(12);
      for (const height of [900, 400]) {
        await page.setViewportSize({ width, height });
        await card.scrollIntoViewIfNeeded();
        await expect
          .poll(async () => (await card.boundingBox())!.height)
          .toBeLessThanOrEqual(height / 2);
        const scroll = await card.evaluate(async (node) => {
          node.scrollTop = node.scrollHeight;
          await new Promise(requestAnimationFrame);
          return { top: node.scrollTop, overflow: node.scrollHeight > node.clientHeight };
        });
        expect(scroll.overflow).toBe(true);
        expect(scroll.top).toBeGreaterThan(0);
        await lastTask.scrollIntoViewIfNeeded();
        await expect(lastTask).toBeInViewport();
        await card.evaluate((node) => {
          node.scrollTop = 0;
        });
        await info.attach(`bounded-tasks-${width}-${height}`, {
          body: await card.screenshot(),
          contentType: "image/png",
        });
      }
      await card.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.getByTestId("checklist-toggle").click();
      await expect(page.getByTestId("checklist-row-scroll-0")).not.toBeAttached();
      await expect.poll(async () => (await card.boundingBox())!.height).toBeLessThan(100);
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}

test("task flowers stay bounded through 300 tasks and follow sidebar labels", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const agent = await seedMockAgentWorkspace({ repoPrefix: "task-flower-", title: "Task flowers" });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "task-flower" });
  try {
    await agent.client.setWorkspaceLabel({
      workspaceId: agent.workspaceId,
      label: { name: "Later", color: "red" },
      assigned: true,
    });
    await openAgentRoute(page, agent);
    const flower = page.getByTestId("checklist-progress");
    const sidebar = page.getByTestId(/^workspace-task-progress-/);
    for (let index = 0; index < 300; index++) {
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "create",
        id: `petal-${index}`,
        text: `Task ${index + 1}`,
      });
      if (![1, 2, 4, 8, 12, 33, 300].includes(index + 1)) continue;
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "update",
        id: "petal-0",
        status: "in_progress",
      });
      // Open the large snapshot after seeding to check a 300-task workspace without
      // making this test depend on processing hundreds of intermediate UI states.
      if (index + 1 === 300) await openAgentRoute(page, agent);
      const count = Math.min(index + 1, 12);
      await expect(flower.locator("svg path[fill]:not([fill='none'])")).toHaveCount(count);
      await expect(sidebar.locator("svg path[fill]:not([fill='none'])")).toHaveCount(count);
      await expect(flower.locator("svg path[fill='none']")).toHaveCount(1);
      await expect(sidebar).toHaveAttribute("aria-valuemax", String(index + 1));
      const label = page.getByTestId("workspace-label-chip-Later");
      const labelBox = (await label.boundingBox())!;
      expect((await sidebar.boundingBox())!.x).toBeGreaterThan(labelBox.x + labelBox.width);
      await sidebar.hover();
      const menu = page.getByTestId("sidebar-menu-backdrop");
      await expect(menu).toBeVisible();
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual((await sidebar.boundingBox())!.x);
      await page.mouse.move(600, 20);
      await info.attach(`flowers-${index + 1}`, {
        body: await page.screenshot({ path: info.outputPath(`flowers-${index + 1}.png`) }),
        contentType: "image/png",
      });
      if (index + 1 === 33) await page.goto("about:blank");
    }
    await page.getByTestId("checklist-toggle").click();
    await expect(page.getByTestId("checklist-row-petal-0")).not.toBeAttached();
    await expect(flower.locator("svg path[fill]:not([fill='none'])")).toHaveCount(12);
  } finally {
    await client.close();
    await agent.cleanup();
  }
});
