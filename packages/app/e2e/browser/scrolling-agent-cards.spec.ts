import { randomUUID } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import type { Locator, TestInfo } from "@playwright/test";
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

async function verifyGoalPauseHelp(page: Page, goalCard: Locator, width: number) {
  const pauseGoal = goalCard.getByRole("button", { name: "Pause goal", exact: true });
  await expect(pauseGoal).toBeEnabled();
  if (width === 390) return;
  await pauseGoal.hover();
  await expect(
    page.getByText("Pause goal. Prevents the goal from continuing automatically.", { exact: true }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
}

test.use({ e2eInjectPaseoTools: true });

for (const width of [1400, 390]) {
  test(`journal Spark tracks visible entries across reload at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({
      colorScheme: "dark",
      reducedMotion: width === 390 ? "reduce" : "no-preference",
    });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "journal-spark-",
      title: "Journal Spark visibility",
      initialPrompt: "emit 2 agent stream updates",
    });
    const journal = new McpClient({ name: "journal-spark-test", version: "1.0.0" });
    try {
      await journal.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents?callerAgentId=${agent.agentId}`,
          ),
        ),
      );
      const ids = Array.from({ length: 12 }, () => randomUUID());
      for (const [index, id] of ids.entries()) {
        expect(
          (
            await journal.callTool({
              name: "append_journal",
              arguments: {
                entryId: id,
                text:
                  `Journal observation ${index + 1}. ` +
                  "Verified the change and retained the decision history. ".repeat(3),
              },
            })
          ).isError,
        ).not.toBe(true);
      }
      await openAgentRoute(page, agent);
      const card = page.getByTestId("agent-journal-card");
      await expect(async () => {
        await card.scrollIntoViewIfNeeded();
        await expect(card).toBeVisible();
      }).toPass();
      const status = (index: number) => page.getByTestId(`journal-status-${ids[index]}`);
      await expect(status(0)).toHaveAttribute("aria-label", "Seen journal entry");
      await expect(status(11)).toHaveAttribute("aria-label", "Unread journal entry");
      await expect(card.getByTestId("journal-unread-count")).toBeVisible();
      await card.screenshot({ path: info.outputPath(`spark-${width}.png`) });

      // Keep the app in the background while exposing unread entries.
      const focusSession = await page.context().newCDPSession(page);
      await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      const { windowId } = await focusSession.send("Browser.getWindowForTarget");
      await focusSession.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      // Jump past the middle. A high-water mark would incorrectly mark these skipped entries.
      await card.getByTestId("agent-journal-card-body-scroll").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForTimeout(1100);
      await expect(status(11)).toHaveAttribute("aria-label", "Unread journal entry");
      await card.screenshot({ path: info.outputPath(`spark-unread-${width}.png`) });
      const transition = status(11).evaluate(
        (node) =>
          new Promise<boolean>((resolve) => {
            const parent = node.querySelector("svg")?.parentElement;
            if (!parent) throw new Error("Missing Spark glyph");
            const spark: Element = parent;
            let moved = false;
            const started = performance.now();
            function sample() {
              let opacity = 1;
              let element: Element | null = spark;
              while (element && element !== node) {
                opacity *= Number(getComputedStyle(element).opacity);
                element = element.parentElement;
              }
              moved ||= opacity > 0 && opacity < 1;
              const settled =
                node.getAttribute("aria-label") === "Seen journal entry" && opacity === 0;
              const timedOut = performance.now() - started > 5000;
              if (settled || timedOut) {
                resolve(moved);
                return;
              }
              requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
          }),
      );
      await focusSession.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await page.bringToFront();
      await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await focusSession.detach();
      await expect(status(11)).toHaveAttribute("aria-label", "Seen journal entry");
      expect(await transition).toBe(width === 1400);
      await expect(status(5)).toHaveAttribute("aria-label", "Unread journal entry");
      await page.reload();
      await expect(card).toBeVisible();
      await expect(status(11)).toHaveAttribute("aria-label", "Seen journal entry");
      await expect(status(5)).toHaveAttribute("aria-label", "Unread journal entry");

      await card.getByTestId("agent-journal-toggle").click();
      const appended = randomUUID();
      expect(
        (
          await journal.callTool({
            name: "append_journal",
            arguments: {
              entryId: appended,
              text: "Appended while the journal was collapsed.",
            },
          })
        ).isError,
      ).not.toBe(true);
      await expect(page.getByTestId(`journal-status-${appended}`)).toHaveCount(0);
      await page.waitForTimeout(1100);
      await card.getByTestId("agent-journal-toggle").click();
      await expect(page.getByTestId(`journal-status-${appended}`)).toHaveAttribute(
        "aria-label",
        "Unread journal entry",
      );

      await card.getByTestId("journal-clear").click();
      await expect(card).toContainText("Journal cleared on this device");
      await card.getByTestId("journal-show-history").click();
      await expect(status(11)).toHaveAttribute("aria-label", "Seen journal entry");
      await expect(status(5)).toHaveAttribute("aria-label", "Unread journal entry");
      const row = page.getByTestId(`journal-entry-${ids[0]}`);
      expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

      // Exercise an actual browser storage failure, then recover through the visible Retry.
      await page.evaluate(() => {
        let size = 64 * 1024;
        let index = 0;
        while (size >= 1) {
          try {
            localStorage.setItem(`journal-quota-fixture-${index++}`, "x".repeat(size));
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== "QuotaExceededError")
              throw error;
            size = Math.floor(size / 2);
          }
        }
      });
      await card.getByTestId("agent-journal-card-body-scroll").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect(
        card.getByText("Could not save or load seen entries on this device."),
      ).toBeVisible();
      await expect(page.getByTestId(`journal-status-${appended}`)).toHaveAttribute(
        "aria-label",
        "Unread journal entry",
      );
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("journal-quota-fixture-")) localStorage.removeItem(key);
        }
      });
      await card.getByRole("button", { name: "Retry", exact: true }).click();
      await card.getByTestId("agent-journal-card-body-scroll").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect(page.getByTestId(`journal-status-${appended}`)).toHaveAttribute(
        "aria-label",
        "Seen journal entry",
      );
    } finally {
      await journal.close();
      await agent.cleanup();
    }
  });
}

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
  const journal = new McpClient({ name: "journal-card-test", version: "1.0.0" });
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
      queueContinuationHeld: true,
      observedAt: new Date().toISOString(),
      goal: {
        threadId: agent.agentId,
        objective: "Goal below queued messages. ".repeat(60),
        status: "paused",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 53640,
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
    await expect(stack.getByTestId("agent-journal-card")).toHaveCount(0);
    await journal.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents?callerAgentId=${agent.agentId}`),
      ),
    );
    const firstEntry = {
      entryId: "11111111-1111-4111-8111-111111111111",
      text: "Chose append-only storage to preserve the decision history.",
    };
    const secondEntry = {
      entryId: "22222222-2222-4222-8222-222222222222",
      text:
        "Verified recovery and retry safety.\n" +
        "Retained each saved entry in its original order. ".repeat(20),
    };
    expect(
      (await journal.callTool({ name: "append_journal", arguments: firstEntry })).isError,
    ).not.toBe(true);
    await expect(stack.getByTestId(`journal-entry-${firstEntry.entryId}`)).toContainText(
      firstEntry.text,
    );
    expect(
      (await journal.callTool({ name: "append_journal", arguments: firstEntry })).isError,
    ).not.toBe(true);
    expect(
      (await journal.callTool({ name: "append_journal", arguments: secondEntry })).isError,
    ).not.toBe(true);
    const entries = stack.getByTestId(/^journal-entry-/);
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText(firstEntry.text);
    await expect(entries.nth(1)).toContainText("Verified recovery and retry safety.");

    const ids = [
      "agent-goal-bar",
      "agent-task-progress-card",
      "agent-journal-card",
      "subagents-card",
      "shared-message-queue",
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

    await page.setViewportSize({ width: 1900, height: 900 });
    const rightColumn = page.getByTestId("thread-cards-column");
    const leftColumn = page.getByTestId("thread-text-column");
    await expect(rightColumn).toBeVisible();
    await expect(leftColumn.getByTestId("question-form-card")).toBeAttached();
    await expect(rightColumn.getByTestId("question-form-card")).toHaveCount(0);
    await Promise.all(ids.map((id) => expect(rightColumn.getByTestId(id)).toBeAttached()));
    await leftColumn.getByTestId("question-form-card").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("questions-left-column.png") });

    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 650 });
      const goalCard = stack.getByTestId("agent-goal-bar");
      await expect(goalCard.getByTestId("agent-goal-toggle")).toHaveAttribute(
        "aria-label",
        "Goal (waiting for messages)",
      );
      await expect(stack.getByTestId("message-queue-toggle")).toHaveAttribute(
        "aria-label",
        "Queued messages",
      );
      await expect(goalCard).toContainText("Goal time: 14h 54m");
      await expect(goalCard).toContainText(
        "Queued messages take priority. The goal will continue automatically afterward.",
      );
      await expect(goalCard).toContainText(
        "Pause goal prevents the goal from continuing automatically.",
      );
      const statusSize = await goalCard
        .getByTestId("agent-goal-toggle-status")
        .evaluate((node) => ({
          status: parseFloat(getComputedStyle(node).fontSize),
          heading: parseFloat(
            getComputedStyle(
              node
                .closest('[data-testid="agent-goal-toggle"]')!
                .querySelector('[data-testid="agent-goal-toggle-title"]')!,
            ).fontSize,
          ),
        }));
      expect(statusSize.status).toBeLessThan(statusSize.heading);
      await goalCard.screenshot({ path: info.outputPath(`goal-status-${width}.png`) });
      await expect
        .poll(async () =>
          goalCard.getByTestId("agent-goal-toggle-status").evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const bounds = node.parentElement!.getBoundingClientRect();
            const text = range.getBoundingClientRect();
            return Math.max(text.right - bounds.right, text.bottom - bounds.bottom);
          }),
        )
        .toBeLessThanOrEqual(1);

      await verifyGoalPauseHelp(page, goalCard, width);

      if (width === 390) {
        await expect(
          goalCard
            .getByTestId("agent-goal-body")
            .getByRole("button", { name: "Clear goal", exact: true }),
        ).toBeAttached();
        expect(
          (await goalCard.getByTestId("agent-goal-clear").boundingBox())?.height,
        ).toBeGreaterThanOrEqual(44);
        const actions = stack.getByTestId(/^subagents-track-(archive|detach)-/);
        for (const action of await actions.all()) {
          await expect
            .poll(async () => (await action.boundingBox())?.height)
            .toBeGreaterThanOrEqual(44);
        }
      }
      const geometry = await stack.evaluate((element, cardIds) => {
        const selectors = [
          ...cardIds.slice(0, 4),
          "agent-history-plugin-pills",
          cardIds[4],
          "question-form-card",
        ];
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
      expect(geometry[2].padding).toBe("12px");
      for (const card of geometry.filter((entry) => entry.id !== "agent-history-plugin-pills")) {
        expect(card.frame).toEqual(geometry[0].frame);
      }
      await checkHeadingGeometry(stack, width);
      await checkHeadingHover(page, stack, width, info);
      const journalCard = stack.getByTestId("agent-journal-card");
      const toggleJournal = stack.getByTestId("agent-journal-toggle");
      await toggleJournal.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      const idle = await toggleJournal.evaluate((node) => getComputedStyle(node).backgroundColor);
      await toggleJournal.hover();
      await expect
        .poll(() => toggleJournal.evaluate((node) => getComputedStyle(node).backgroundColor))
        .not.toBe(idle);
      const expandedHeight = (await journalCard.boundingBox())!.height;
      await toggleJournal.click();
      await expect(toggleJournal).toHaveAttribute("aria-expanded", "false");
      await expect(entries).toHaveCount(0);
      expect((await journalCard.boundingBox())!.height).toBeLessThan(expandedHeight);
      await toggleJournal.click();
      await expect(entries).toHaveCount(2);
      const rowGeometry = await entries.first().evaluate((node) => {
        const timestamp = node
          .querySelector('[data-testid="journal-timestamp"]')!
          .getBoundingClientRect();
        const text = node.querySelector('[data-testid="journal-text"]')!.getBoundingClientRect();
        const marker = node
          .querySelector('[data-testid^="journal-status-"]')!
          .getBoundingClientRect();
        return {
          markerInset: marker.left - node.getBoundingClientRect().left,
          markerRight: marker.right,
          timestampLeft: timestamp.left,
          timestampRight: timestamp.right,
          timestampInset: timestamp.left - node.getBoundingClientRect().left,
          textTopOffset: text.top - timestamp.top,
          textLeft: text.left,
          textWidth: text.width,
          timestampWidth: timestamp.width,
          overflow: node.scrollWidth > node.clientWidth,
        };
      });
      expect(rowGeometry.timestampRight).toBeLessThan(rowGeometry.textLeft);
      expect(rowGeometry.markerInset).toBe(8);
      expect(rowGeometry.markerRight).toBeLessThan(rowGeometry.timestampLeft);
      expect(rowGeometry.timestampInset).toBe(36);
      expect(rowGeometry.textTopOffset).toBe(-2);
      expect(rowGeometry.textWidth).toBeGreaterThan(rowGeometry.timestampWidth);
      expect(rowGeometry.overflow).toBe(false);

      await checkDisclosures(stack, width, info);
      await checkSubagentRows(stack, width, info);
      const toggle = stack.getByTestId("subagents-group-paseo-toggle");
      const headerHeight = await toggle.evaluate((node) => node.getBoundingClientRect().height);
      const rowHeight = await stack.getByTestId("subagents-card").evaluate((card) => {
        const row = card.querySelector('[data-testid="subagents-card-header"]');
        if (!row) throw new Error("Subagent header row missing");
        return row.getBoundingClientRect().height;
      });
      expect(headerHeight).toBe(rowHeight);
      const clearFinished = stack.getByTestId("subagents-track-archive-finished");
      await expect(clearFinished).toBeVisible();
      expect((await clearFinished.boundingBox())?.height).toBe(headerHeight);
      expect(headerHeight).toBe(width === 390 ? 44 : 32);
      if (width === 1200) {
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
      const subagentScrolls = await page
        .getByTestId("subagents-card-body-scroll")
        .evaluate((node) => node.scrollHeight > node.clientHeight);
      if (!subagentScrolls) expect(subagentBottomInset).toBeCloseTo(12, 0);
      if (width === 1200) {
        const composerFrame = await page.getByTestId("message-input-surface").evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.backgroundColor, style.borderColor, style.borderWidth, style.borderRadius];
        });
        expect(composerFrame).toEqual(geometry[0].frame);
      }
      for (const card of geometry.filter((entry) => entry.id !== "agent-history-plugin-pills")) {
        expect(card.frame).toEqual(geometry[2].frame);
        expect(card.padding).toBe("12px");
        expect(card.width).toBe(geometry[2].width);
      }
      const goalActionInset = await stack.getByTestId("agent-goal-bar").evaluate((card) => {
        const header = card.firstElementChild?.firstElementChild;
        const action = card.querySelector('[data-testid="agent-goal-expand"]');
        if (!header || !action) throw new Error("Goal controls missing");
        return action.getBoundingClientRect().top - header.getBoundingClientRect().top;
      });
      expect(goalActionInset).toBe(0);
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
          const goal = await page.getByTestId("question-form-card").boundingBox();
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
    await page.reload();
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText(firstEntry.text);
    await expect(entries.nth(1)).toContainText("Verified recovery and retry safety.");
    await captureConsistentCards(page, info);
    await checkFixedHeaders(page, info, client, agent.agentId);
    for (const width of [1400, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await stack.getByTestId("journal-clear").click();
      await expect(entries).toHaveCount(0);
      await expect(
        stack.getByText("Journal cleared on this device. New entries will appear here."),
      ).toBeVisible();
      await page.reload();
      await expect(stack.getByTestId("journal-show-history")).toBeVisible();
      await expect(entries).toHaveCount(0);
      await stack.getByTestId("journal-show-history").click();
      await expect(entries).toHaveCount(2);
    }
    await stack.getByTestId("journal-clear").click();
    await expect(entries).toHaveCount(0);
    expect(
      (
        await journal.callTool({
          name: "append_journal",
          arguments: {
            entryId: "33333333-3333-4333-8333-333333333333",
            text: "New entry after clearing the card.",
          },
        })
      ).isError,
    ).not.toBe(true);
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText("New entry after clearing the card.");
    await stack.getByTestId("journal-show-history").click();
    await expect(entries).toHaveCount(3);
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
    await journal.close();
    await agent.cleanup();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

async function checkHeadingHover(page: Page, stack: Locator, width: number, info: TestInfo) {
  const toggles = [
    "agent-goal-toggle",
    "checklist-toggle",
    "agent-journal-toggle",
    "subagents-group-paseo-toggle",
    "message-queue-toggle",
  ];
  let highlight: string | undefined;
  for (const id of toggles) {
    const toggle = stack.getByTestId(id);
    await toggle.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const idle = await toggle.evaluate((node) => getComputedStyle(node).backgroundColor);
    const geometry = await toggle.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const icon = node.firstElementChild!.getBoundingClientRect();
      const wrapper = node.parentElement!;
      const header = wrapper.parentElement!;
      const next = wrapper.nextElementSibling;
      const card = header.parentElement!.parentElement!.parentElement!;
      return {
        leftInset: box.left - card.getBoundingClientRect().left,
        iconInset: icon.left - box.left,
        rightGap:
          (next ? next.getBoundingClientRect().left : header.getBoundingClientRect().right) -
          box.right,
        width: box.width,
        height: box.height,
      };
    });
    expect(geometry.height, id).toBe(width === 390 ? 44 : 32);
    expect(geometry.leftInset, id).toBeCloseTo(1, 0);
    expect(geometry.iconInset, id).toBeCloseTo(12, 0);
    expect(geometry.rightGap, id).toBeLessThanOrEqual(8);
    await toggle.hover({ position: { x: 4, y: geometry.height / 2 } });
    await expect
      .poll(() => toggle.evaluate((node) => getComputedStyle(node).backgroundColor))
      .not.toBe(idle);
    const color = await toggle.evaluate((node) => getComputedStyle(node).backgroundColor);
    highlight ??= color;
    expect(color, id).toBe(highlight);
    await toggle.hover({ position: { x: geometry.width - 4, y: geometry.height / 2 } });
    await expect
      .poll(() => toggle.evaluate((node) => getComputedStyle(node).backgroundColor))
      .toBe(highlight);
    await info.attach(`heading-hover-${id}-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`heading-hover-${id}-${width}.png`) }),
      contentType: "image/png",
    });
    await toggle.click({ position: { x: 4, y: geometry.height / 2 } });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click({ position: { x: geometry.width - 4, y: geometry.height / 2 } });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

// Measure the rendered contract, not component-specific padding implementations.
async function checkHeadingGeometry(stack: Locator, width: number) {
  const ids = [
    "subagents-card",
    "agent-task-progress-card",
    "agent-journal-card",
    "shared-message-queue",
    "agent-goal-bar",
    "question-form-card",
  ];
  const geometry = await stack.evaluate(
    (root, cardIds) =>
      cardIds.map((id) => {
        const card = root.querySelector(`[data-testid="${id}"]`)!;
        const header = card.querySelector(`[data-testid="${id}-header"]`)!.firstElementChild!;
        const disclosure = header.querySelector("[aria-expanded]");
        const icon = disclosure ? disclosure.firstElementChild! : header.firstElementChild!;
        const title = icon.nextElementSibling!;
        const box = header.getBoundingClientRect();
        const center = (node: Element) => {
          const rect = node.getBoundingClientRect();
          return rect.y + rect.height / 2;
        };
        const marks = [
          icon,
          title,
          ...header.querySelectorAll('[data-testid$="-arrow"], [role="button"]'),
        ];
        const count = header.querySelector('[data-testid$="-arrow"]')?.nextElementSibling;
        if (count) marks.push(count);
        const button = header.querySelector('[data-testid="subagents-track-archive-finished"]');
        const buttonBox = button?.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        return {
          id,
          height: box.height,
          iconX: icon.getBoundingClientRect().x - cardBox.x,
          titleX: title.getBoundingClientRect().x - cardBox.x,
          titleWidth: title.getBoundingClientRect().width,
          offsets: marks.map((node) => center(node) - center(header)),
          topClearance: buttonBox && buttonBox.top - cardBox.top,
          rightClearance: buttonBox && cardBox.right - buttonBox.right,
          overflow: header.scrollWidth > header.clientWidth,
        };
      }),
    ids,
  );
  for (const card of geometry) {
    expect(card.height, card.id).toBe(width === 390 ? 44 : 32);
    expect(card.titleWidth, card.id).toBeGreaterThan(10);
    expect(card.iconX, card.id).toBeCloseTo(geometry[0].iconX, 1);
    expect(card.titleX, card.id).toBeCloseTo(geometry[0].titleX, 1);
    for (const offset of card.offsets) expect(Math.abs(offset), card.id).toBeLessThanOrEqual(1);
    expect(card.overflow, card.id).toBe(false);
  }
  expect(geometry[0].topClearance).toBeCloseTo(geometry[0].rightClearance!, 1);
}

async function captureConsistentCards(page: Page, info: TestInfo) {
  await page.setViewportSize({ width: 1400, height: 1600 });
  for (const id of [
    "subagents-card",
    "agent-task-progress-card",
    "agent-journal-card",
    "shared-message-queue",
    "agent-goal-bar",
    "question-form-card",
  ]) {
    const card = page.getByTestId(id);
    await card.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await card.screenshot({ path: info.outputPath(`consistent-${id}.png`) });
  }
}

async function checkSubagentRows(stack: Locator, width: number, info: TestInfo) {
  const rowLayout = await stack.getByTestId("subagents-card").evaluate((card) => {
    return [...card.querySelectorAll('[data-testid^="subagents-track-row-"]')].map((row) => {
      const label = row.querySelector('[data-testid^="subagents-track-label-"]')!;
      const metadata = row.querySelector('[data-testid^="subagents-track-metadata-"]')!;
      const action = row.querySelector('[data-testid^="subagents-track-detach-"]')!;
      const a = label.getBoundingClientRect();
      const b = metadata.getBoundingClientRect();
      const c = action.getBoundingClientRect();
      return {
        centers: [a.y + a.height / 2, b.y + b.height / 2, c.y + c.height / 2],
        labelRight: a.right,
        metadataLeft: b.left,
        metadataRight: b.right,
        actionLeft: c.left,
        whiteSpace: getComputedStyle(metadata).whiteSpace,
        separator: getComputedStyle(row.parentElement!).borderTopWidth,
        overflow: row.scrollWidth > row.clientWidth,
      };
    });
  });
  expect(rowLayout).toHaveLength(5);
  for (const row of rowLayout) {
    expect(Math.max(...row.centers) - Math.min(...row.centers)).toBeLessThanOrEqual(1);
    expect(row.labelRight).toBeLessThanOrEqual(row.metadataLeft);
    expect(row.metadataRight).toBeLessThanOrEqual(row.actionLeft);
    expect(row.whiteSpace).toBe("nowrap");
    expect(row.separator).toBe("0px");
    expect(row.overflow).toBe(false);
  }
  await stack
    .getByTestId("subagents-card")
    .screenshot({ path: info.outputPath(`single-line-subagents-${width}.png`) });
}

async function cardHeaderOffset(card: Locator) {
  // Read both rectangles in one browser frame. Conversation scrolling can occur
  // between separate boundingBox calls without moving the header inside its card.
  return card.evaluate((node) => {
    const header = node.querySelector(
      `[data-testid="${node.getAttribute("data-testid")}-header"]`,
    )!;
    return header.getBoundingClientRect().top - node.getBoundingClientRect().top;
  });
}

async function checkFixedHeaders(
  page: Page,
  info: TestInfo,
  client: DaemonClient,
  agentId: string,
) {
  for (let index = 0; index < 10; index++) {
    const result = await client.mutateMessageQueue(agentId, {
      kind: "enqueue",
      operationId: `scroll-queue-${index}`,
      messageId: `scroll-queue-${index}`,
      text: `Scroll queue row ${index}`,
      attachments: [],
    });
    expect(result.error).toBeNull();
    expect(result.snapshot?.items.some((item) => item.id === `scroll-queue-${index}`)).toBe(true);
  }

  // Load the persisted overflow fixture before measuring layout. Queue push
  // delivery is covered separately; this check needs all eleven rows present.
  await page.reload();
  await expect(page.getByTestId("shared-message-queue")).toContainText("Scroll queue row 9");

  for (const width of [1400, 390]) {
    await page.setViewportSize({ width, height: 400 });
    for (const id of [
      "subagents-card",
      "agent-journal-card",
      "shared-message-queue",
      "agent-goal-bar",
      "question-form-card",
    ]) {
      const card = page.getByTestId(id);
      await card.scrollIntoViewIfNeeded();
      const header = page.getByTestId(`${id}-header`);
      const before = await cardHeaderOffset(card);
      const result = await page.getByTestId(`${id}-body-scroll`).evaluate(async (node) => {
        const first = node.firstElementChild!;
        const contentTop = first.getBoundingClientRect().top;
        node.scrollTop = node.scrollHeight;
        await new Promise(requestAnimationFrame);
        return {
          offset: node.scrollTop,
          movement: contentTop - first.getBoundingClientRect().top,
        };
      });
      expect((await card.boundingBox())!.height).toBeLessThanOrEqual(200);
      expect(result.offset).toBeGreaterThan(0);
      expect(result.movement).toBeGreaterThan(0);
      expect(await cardHeaderOffset(card)).toBeCloseTo(before, 0);
      await header.scrollIntoViewIfNeeded();
      await expect(header).toBeInViewport();
      await card.screenshot({ path: info.outputPath(`fixed-header-${id}-${width}.png`) });
      await page.getByTestId(`${id}-body-scroll`).evaluate((node) => {
        node.scrollTop = 0;
      });
    }
  }
}

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
    await expect(card.getByTestId("checklist-count")).toHaveText("0 / 1");
    await expect(card).toContainText("stress-update-1");
    await expect(ring).toHaveAttribute("aria-valuenow", "1");
    await expect(ring).toHaveAttribute("aria-valuemax", "2");
    await expect(ring).toHaveAttribute("aria-label", /1\/2 tasks \(50%\).*active/);
    await client.sendAgentMessage(sibling.id, "emit 2 agent stream updates");
    await expect(ring).toHaveAttribute("aria-valuenow", "0");
    await page.reload();
    await expect(card.getByTestId("checklist-count")).toHaveText("0 / 1");
    await expect(ring).toHaveAttribute("aria-label", /0\/2 tasks \(0%\).*active/);
    await client.archiveAgent(sibling.id);
    await expect(ring).toHaveAttribute("aria-valuemax", "1");
    await client.sendAgentMessage(agent.agentId, "emit 1 agent stream updates");
    await expect(card.getByTestId("checklist-count")).toHaveText("1 / 1");
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
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 1");
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
      const firstRow = page.getByTestId("checklist-row-first");
      const spinner = firstRow.getByTestId("task-running-spinner");
      await expect(spinner).not.toBeAttached();
      for (const status of ["in_progress", "pending", "in_progress"] as const) {
        await client.mutateAgentChecklist(agent.agentId, {
          operation: "update",
          id: "first",
          status,
        });
        if (status === "in_progress") await expect(spinner).toBeVisible();
        else await expect(spinner).not.toBeAttached();
      }
      await page.screenshot({ path: info.outputPath("active-task-spinner.png") });
      await firstRow.getByRole("button", { name: "Details for First agent-created task" }).click();
      await page
        .getByTestId("checklist-editor")
        .getByRole("button", { name: "Blocked", exact: true })
        .click();
      await page.getByTestId("checklist-save").click();
      await expect(firstRow.getByText("Blocked", { exact: true })).toBeVisible();
      await expect(spinner).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 1");
      await page.reload();
      await expect(firstRow.getByText("Blocked", { exact: true })).toBeVisible();
      const blockedControl = firstRow.getByRole("checkbox");
      const blockedIcon = blockedControl.locator("svg");
      await expect(blockedIcon.locator('circle[r="10"]')).toHaveCount(1);
      await expect(blockedIcon.locator('line[y1="8"][y2="12"]')).toHaveCount(1);
      await expect(blockedIcon.locator('line[y1="16"][y2="16"]')).toHaveCount(1);
      const editIcon = firstRow
        .getByRole("button", { name: "Details for First agent-created task" })
        .locator("svg");
      const stroke = (icon: Locator) => icon.evaluate((node) => getComputedStyle(node).stroke);
      expect(await stroke(blockedIcon)).toBe(await stroke(editIcon));
      await blockedControl.hover();
      const hoveredStroke = await stroke(blockedIcon);
      await editIcon.hover();
      expect(hoveredStroke).toBe(await stroke(editIcon));
      await page.screenshot({ path: info.outputPath("blocked-task.png") });
      expect((await client.getAgentChecklist(agent.agentId))[0]).toMatchObject({
        status: "blocked",
        completed: false,
      });
      await firstRow.getByRole("button", { name: "Details for First agent-created task" }).click();
      await page
        .getByTestId("checklist-editor")
        .getByRole("button", { name: "In progress", exact: true })
        .click();
      await page.getByTestId("checklist-save").click();
      await expect(spinner).toBeVisible();
      await expect(firstRow.getByText("Blocked", { exact: true })).not.toBeAttached();
      await firstRow.getByRole("checkbox", { name: "Complete First agent-created task" }).click();
      await expect(spinner).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("1 / 1");
      await page.getByTestId("checklist-clear-completed").click();
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
      await expect(page.getByTestId("checklist-count")).toHaveText("2 / 2");
      await page.getByRole("button", { name: "Details for Build API", exact: true }).click();
      const footer = page.getByTestId("checklist-editor-actions");
      await footer.scrollIntoViewIfNeeded();
      const deleteButton = footer.getByRole("button", { name: "Delete task", exact: true });
      const closeButton = footer.getByRole("button", { name: "Close", exact: true });
      const saveButton = footer.getByTestId("checklist-save");
      const footerBox = (await footer.boundingBox())!;
      const deleteBox = (await deleteButton.boundingBox())!;
      const closeBox = (await closeButton.boundingBox())!;
      const saveBox = (await saveButton.boundingBox())!;
      expect(deleteBox.x).toBeCloseTo(footerBox.x, 0);
      expect(saveBox.x + saveBox.width).toBeCloseTo(footerBox.x + footerBox.width, 0);
      if (Math.abs(closeBox.y - deleteBox.y) < 1) {
        expect(closeBox.x).toBeGreaterThan(deleteBox.x + deleteBox.width);
      } else {
        expect(closeBox.y).toBeGreaterThanOrEqual(deleteBox.y + deleteBox.height + 8);
      }
      expect(closeBox.y).toBeCloseTo(saveBox.y, 0);
      expect(saveBox.x).toBeGreaterThan(closeBox.x + closeBox.width);
      await expect(footer).toHaveCSS("padding-top", "16px");
      const deleteColor = await deleteButton.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      const channels = deleteColor.match(/\d+/g)!.map(Number);
      expect(channels[0]).toBeGreaterThan(channels[1]);
      expect(channels[0]).toBeGreaterThan(channels[2]);
      await page.screenshot({ path: info.outputPath("task-editor-footer.png") });
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
      await expect(page.getByTestId("checklist-count")).toHaveText("1 / 2");
      await page.reload();
      await expect(
        page.getByRole("checkbox", { name: "Complete Agent revision", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        const held: (() => void)[] = [];
        WebSocket.prototype.send = function (data) {
          const message = typeof data === "string" ? JSON.parse(data).message : null;
          if (
            message?.type === "agent.checklist.mutate.request" &&
            message.mutation?.operation === "reorder"
          ) {
            held.push(() => send.call(this, data));
          } else send.call(this, data);
        };
        Object.assign(window, {
          releaseTaskOrder: () => held.splice(0).forEach((release) => release()),
        });
      });
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
      const staysDropped = await page.evaluate(async () => {
        for (let frame = 0; frame < 30; frame++) {
          await new Promise(requestAnimationFrame);
          const rows = [...document.querySelectorAll('[data-testid^="checklist-row-"]')];
          if (rows[0]?.getAttribute("data-testid") !== "checklist-row-dependent") return false;
          if (rows[0]!.getBoundingClientRect().top >= rows[1]!.getBoundingClientRect().top)
            return false;
        }
        return true;
      });
      expect(staysDropped).toBe(true);
      await page.evaluate(() =>
        (window as unknown as { releaseTaskOrder(): void }).releaseTaskOrder(),
      );
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
      const arrowOrder = await page.getByTestId("checklist-toggle-arrow").evaluate((node) => ({
        title: node.previousElementSibling!.getBoundingClientRect().right,
        arrowLeft: node.getBoundingClientRect().left,
        arrowRight: node.getBoundingClientRect().right,
        count: node.nextElementSibling!.getBoundingClientRect().left,
      }));
      expect(arrowOrder.arrowLeft).toBeGreaterThan(arrowOrder.title);
      expect(arrowOrder.count).toBeGreaterThan(arrowOrder.arrowRight);
      await page.getByTestId("checklist-toggle").click();
      await expect(page.getByTestId("checklist-row-dependent")).not.toBeAttached();
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 2");
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
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 1");
      expect((await client.getAgentChecklist(agent.agentId)).map((task) => task.id)).toEqual([
        api!.id!,
      ]);
      await expect(page.getByTestId("checklist-clear-completed")).not.toBeAttached();
      for (const id of ["finished-a", "finished-b", "active"]) {
        await client.mutateAgentChecklist(agent.agentId, {
          operation: "create",
          id,
          text: id,
          blockedBy: id === "finished-b" ? ["finished-a"] : [],
        });
        await client.mutateAgentChecklist(agent.agentId, {
          operation: "update",
          id,
          status: id === "active" ? "in_progress" : "completed",
        });
      }
      await client.mutateAgentChecklist(agent.agentId, {
        operation: "update",
        id: api!.id!,
        blockedBy: ["finished-b"],
      });
      const clear = page.getByTestId("checklist-clear-completed");
      await expect(clear).toBeVisible();
      await page.screenshot({ path: info.outputPath("clear-completed-tasks.png") });
      await clear.click();
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 2");
      await expect(clear).not.toBeAttached();
      const remaining = await client.getAgentChecklist(agent.agentId);
      expect(remaining.map((task) => task.id)).toEqual([api!.id!, "active"]);
      expect(remaining[0].blockedBy).toEqual([]);
      expect(remaining[1].status).toBe("in_progress");
      await page.reload();
      await expect(page.getByTestId("checklist-count")).toHaveText("0 / 2");
      await client.mutateAgentChecklist(agent.agentId, { operation: "delete", id: "active" });
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
        const header = page.getByTestId("agent-task-progress-card-header");
        const headerBefore = (await header.boundingBox())!;
        const body = page.getByTestId("agent-task-progress-card-body-scroll");
        const scroll = await body.evaluate(async (node) => {
          node.scrollTop = node.scrollHeight;
          await new Promise(requestAnimationFrame);
          return { top: node.scrollTop, overflow: node.scrollHeight > node.clientHeight };
        });
        const headerAfter = (await header.boundingBox())!;
        expect(headerAfter.y).toBeCloseTo(headerBefore.y, 0);
        await expect(page.getByTestId("checklist-toggle")).toBeInViewport();
        expect(scroll.overflow).toBe(true);
        expect(scroll.top).toBeGreaterThan(0);
        await lastTask.scrollIntoViewIfNeeded();
        await expect(lastTask).toBeInViewport();
        await body.evaluate((node) => {
          node.scrollTop = 0;
        });
        await info.attach(`bounded-tasks-${width}-${height}`, {
          body: await card.screenshot(),
          contentType: "image/png",
        });
      }
      await page.getByTestId("agent-task-progress-card-body-scroll").evaluate((node) => {
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
      if (![1, 2, 3, 4, 8, 12, 33, 300].includes(index + 1)) continue;
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
      await expect(flower.locator("svg path[fill='none']")).toHaveCount(0);
      await expect(sidebar).toHaveAttribute("aria-valuemax", String(index + 1));
      const label = page.getByTestId("workspace-label-chip-Later");
      const labelBox = (await label.boundingBox())!;
      expect((await sidebar.boundingBox())!.x).toBeGreaterThan(labelBox.x + labelBox.width);
      await sidebar.hover();
      const menu = page.getByTestId("sidebar-menu-backdrop");
      await expect(menu).toBeVisible();
      const menuBox = (await menu.boundingBox())!;
      const flowerBox = (await sidebar.boundingBox())!;
      expect(menuBox.x + menuBox.width).toBeCloseTo(flowerBox.x + flowerBox.width, 0);
      const menuOwnsEdge = await menu.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      });
      expect(menuOwnsEdge).toBe(true);
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

async function checkDisclosures(stack: Locator, width: number, info: TestInfo) {
  for (const id of [
    "subagents-group-paseo-toggle",
    "checklist-toggle",
    "message-queue-toggle",
    "agent-goal-toggle",
    "agent-journal-toggle",
  ]) {
    const arrow = stack.getByTestId(`${id}-arrow`);
    const order = await arrow.evaluate((node) => {
      const arrowBox = node.getBoundingClientRect();
      const titleBox = node.previousElementSibling!.getBoundingClientRect();
      const countBox = node.nextElementSibling?.getBoundingClientRect();
      return {
        titleRight: titleBox.right,
        arrowLeft: arrowBox.left,
        arrowRight: arrowBox.right,
        countLeft: countBox?.left,
      };
    });
    expect(order.arrowLeft).toBeGreaterThan(order.titleRight);
    if (order.countLeft !== undefined) expect(order.countLeft).toBeGreaterThan(order.arrowRight);
  }
  for (const [toggleId, bodyId, cardId, actionId] of [
    [
      "message-queue-toggle",
      "message-queue-body",
      "shared-message-queue",
      "message-queue-pause-resume",
    ],
    ["agent-goal-toggle", "agent-goal-body", "agent-goal-bar", "agent-goal-expand"],
  ]) {
    const disclosure = stack.getByTestId(toggleId);
    const body = stack.getByTestId(bodyId);
    const card = stack.getByTestId(cardId);
    const expandedHeight = (await card.boundingBox())!.height;
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(body).toBeHidden();
    await expect(stack.getByTestId(actionId)).toBeVisible();
    expect((await card.boundingBox())!.height).toBeLessThan(expandedHeight);
    await card.screenshot({ path: info.outputPath(`${cardId}-collapsed-${width}.png`) });
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
  }
}

test("thread columns resize independently and follow primary-region width", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1900, height: 850 });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "thread-columns-",
    title: "Independent thread columns",
    initialPrompt: "emit 40 agent stream updates",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "thread-columns" });
  try {
    await client.addProject(agent.cwd);
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      expectedRevision: 0,
      operationId: "pause-columns",
    });
    for (let i = 0; i < 12; i++) {
      await client.mutateMessageQueue(agent.agentId, {
        kind: "enqueue",
        operationId: `enqueue-column-${i}`,
        messageId: `column-${i}`,
        text: `Queued message ${i}: preserve independent scrolling and input.`,
        attachments: [],
      });
    }
    for (let i = 0; i < 5; i++) {
      await agent.client.createAgent({
        provider: "mock",
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        title: `Column worker ${i}`,
        modeId: "load-test",
        model: "e2e-fast-stream",
        labels: { [PARENT_AGENT_ID_LABEL]: agent.agentId },
      });
    }
    await openAgentRoute(page, agent);
    const cards = page.getByTestId("thread-cards-column");
    const text = page.getByTestId("thread-text-column");
    const region = page.getByTestId("thread-content-region");
    await expect(cards).toBeVisible();
    await expect(cards.getByTestId("shared-message-queue")).toBeAttached();
    await expect(page.getByTestId("thread-cards-scroll")).toHaveCount(0);
    const box = async (locator: Locator) => {
      const result = await locator.boundingBox();
      if (!result) throw new Error("Missing column geometry");
      return result;
    };
    const centered = async () => {
      await expect(async () => {
        const t = await box(text);
        const c = await box(cards);
        const all = await box(region);
        expect(all.x + all.width - c.x - c.width).toBeCloseTo(16, 0);
        const expectedLeft = Math.min(all.x + (all.width - t.width) / 2, c.x - 32 - t.width);
        expect(t.x).toBeCloseTo(expectedLeft, 0);
      }).toPass({ timeout: 5000 });
    };
    const drag = async (id: string, delta: number) => {
      const handle = page.getByTestId(id);
      await handle.hover();
      await expect(page.getByTestId(`${id}-highlight`)).toBeVisible();
      const h = await box(handle);
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + delta, h.y + h.height / 2, { steps: 12 });
      await page.mouse.up();
    };
    await centered();
    await info.attach("thread-columns-initial", {
      body: await page.screenshot({ path: info.outputPath("columns-initial.png") }),
      contentType: "image/png",
    });
    const composer = page.getByTestId("message-input-surface");
    const composerBefore = await box(composer);
    const textBefore = await box(text);
    const cardsBefore = await box(cards);
    await drag("thread-text-resize", -60);
    await expect.poll(async () => (await box(text)).width).toBeCloseTo(textBefore.width - 120, 0);
    expect((await box(cards)).width).toBeCloseTo(cardsBefore.width, 0);
    await centered();
    const resizedText = (await box(text)).width;
    await drag("thread-cards-resize", -70);
    await expect.poll(async () => (await box(cards)).width).toBeCloseTo(cardsBefore.width + 70, 0);
    expect((await box(text)).width).toBeCloseTo(resizedText, 0);
    await centered();
    expect(await box(composer)).toEqual(composerBefore);

    const queueCard = page.getByTestId("shared-message-queue");
    const expandedHeight = (await box(queueCard)).height;
    await page.getByTestId("message-queue-toggle").click();
    await expect.poll(async () => (await box(queueCard)).height).toBeLessThan(80);
    await page.getByTestId("message-queue-toggle").click();
    await expect.poll(async () => (await box(queueCard)).height).toBeCloseTo(expandedHeight, 0);

    const queueBody = page.getByTestId("shared-message-queue-body-scroll");
    const headerBefore = await box(page.getByTestId("shared-message-queue-header"));
    const innerOffset = await queueBody.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    });
    expect(innerOffset).toBeGreaterThan(0);
    const headerAfter = await box(page.getByTestId("shared-message-queue-header"));
    expect(headerAfter.y).toBeCloseTo(headerBefore.y, 0);
    expect(headerAfter.height).toBeCloseTo(headerBefore.height, 0);
    const stack = page.getByTestId("thread-cards-stack");
    const stackBox = await box(stack);
    const queueBox = await box(page.getByTestId("shared-message-queue"));
    expect(queueBox.y + queueBox.height).toBeLessThanOrEqual(stackBox.y + stackBox.height + 1);
    expect(
      await stack.evaluate((node) => node.scrollHeight - node.clientHeight),
    ).toBeLessThanOrEqual(1);
    const transcript = page.locator('[data-testid="agent-chat-scroll"]');
    await expect(transcript).toHaveCSS("scrollbar-width", "none");
    await transcript.evaluate((node) => {
      node.scrollTop = 100;
    });
    await expect.poll(() => transcript.evaluate((node) => node.style.maskImage)).toContain("64px");
    await page.setViewportSize({ width: 2800, height: 850 });
    await expect
      .poll(async () => {
        const t = await box(text);
        const c = await box(composer);
        return Math.abs(t.x + t.width / 2 - c.x - c.width / 2);
      })
      .toBeLessThan(1);
    await centered();
    await page.setViewportSize({ width: 1900, height: 850 });
    await centered();
    await info.attach("thread-columns-wide", {
      body: await page.screenshot({ path: info.outputPath("columns-wide.png") }),
      contentType: "image/png",
    });
    await page.reload();
    await expect(cards).toBeVisible();
    await expect.poll(async () => (await box(text)).width).toBeCloseTo(resizedText, 0);
    await expect.poll(async () => (await box(cards)).width).toBeCloseTo(cardsBefore.width + 70, 0);
    await drag("thread-cards-resize", 1000);
    await expect.poll(async () => (await box(cards)).width).toBeCloseTo(220, 0);
    await centered();
    await page.reload();
    await expect.poll(async () => (await box(cards)).width).toBeCloseTo(220, 0);
    await page.setViewportSize({ width: 1500, height: 850 });
    await expect(cards).toBeVisible();
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await expect(cards).toHaveCount(0);
    expect((await box(region)).width).toBeLessThan(1080);
    await expect(page.getByTestId("agent-history-task-cards")).toHaveCount(1);
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await expect(cards).toBeVisible();
    await drag("left-sidebar-resize-handle", 160);
    await expect(cards).toHaveCount(0);
    expect((await box(region)).width).toBeLessThan(1080);
    await drag("left-sidebar-resize-handle", -160);
    await expect(cards).toBeVisible();
    await page.setViewportSize({ width: 390, height: 850 });
    await expect(cards).toHaveCount(0);
    await expect(page.getByTestId("thread-text-resize")).toHaveCount(0);
    await expect(page.getByTestId("message-input-surface")).toBeVisible();
    await info.attach("thread-columns-narrow", {
      body: await page.screenshot({ path: info.outputPath("columns-narrow.png") }),
      contentType: "image/png",
    });
  } catch (error) {
    await info.attach("thread-columns-failure", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    throw error;
  } finally {
    await client.close();
    await agent.cleanup();
  }
});
