import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { expectComposerVisible } from "../support/helpers/composer";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

test("recovery stays in the Messages card and obsolete send controls retire on reconnect", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "queue-recovery-",
    title: "Queue recovery",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "queue-recovery" });
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page, { timeout: 30_000 });
    await page.evaluate(
      async ({ serverId, agentId }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("paseo-message-outbox", 1);
          request.addEventListener("upgradeneeded", () =>
            request.result.createObjectStore("operations"),
          );
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () => reject(request.error));
        });
        const transaction = db.transaction("operations", "readwrite");
        const store = transaction.objectStore("operations");
        for (const [operationId, kind, dismissed] of [
          ["stale-send", "send_now", false],
          ["retained-send", "send_now", true],
          ["preserved-edit", "edit", false],
        ] as const) {
          const operation = {
            kind,
            operationId,
            messageId: "departed",
            expectedRevision: 0,
            ...(kind === "edit"
              ? { text: "Keep my unsynchronized edit", attachments: [] }
              : { expectedTurnId: null }),
          };
          store.put(
            {
              version: 1,
              serverId,
              agentId,
              revision: 1,
              createdAt: Date.now(),
              operation,
              prepared: operation,
              localAttachments: [],
              dismissed,
              error: {
                code: "delivery_conflict",
                message: "Resolve pending delivery before sending another message now.",
              },
            },
            JSON.stringify([serverId, agentId, operationId]),
          );
        }
        await new Promise<void>((resolve, reject) => {
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("error", () => reject(transaction.error));
        });
        db.close();
        localStorage.setItem(
          "@paseo:e2e-disable-default-seed-once",
          localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
        );
      },
      { serverId: getServerId(), agentId: agent.agentId },
    );
    await page.reload();
    await expectComposerVisible(page, { timeout: 30_000 });
    const card = page.getByTestId("shared-message-queue");
    await expect(card).toContainText("Messages");
    await expect(card).toContainText("Keep my unsynchronized edit");
    await expect(card).not.toContainText("Send queued message now");
    await expect(page.getByTestId("queue-recovery-status")).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(card).toBeVisible();
      const bounds = await card.boundingBox();
      expect(bounds!.height).toBeLessThanOrEqual(451);
      expect(bounds!.width).toBeLessThanOrEqual(width);
      await test.info().attach(`recovery-card-${width}`, {
        body: await card.screenshot({
          path: test.info().outputPath(`queue-heading-status-${width}.png`),
        }),
        contentType: "image/png",
      });
    }
    const queue = await client.readMessageQueue(agent.agentId);
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      operationId: "pause",
      paused: true,
      expectedRevision: queue.snapshot!.revision,
    });
    await client.mutateMessageQueue(agent.agentId, {
      kind: "enqueue",
      operationId: "enqueue",
      messageId: "new-message",
      text: "A new queued message",
      attachments: [],
    });
    await expect(card).toContainText("A new queued message");
    await expect(
      card.getByRole("button", { name: "Send queued message now", exact: true }),
    ).toBeDisabled();
    await card.getByRole("button", { name: "Keep local copy and continue queue" }).click();
    await expect(card).toContainText("Kept locally");
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(card).toContainText("Keep my unsynchronized edit");
    await expect(
      card.getByRole("button", { name: "Send queued message now", exact: true }),
    ).toBeEnabled();
    // A control-only failure must retain the card even after the server queue empties.
    await client.mutateMessageQueue(agent.agentId, {
      kind: "delete",
      operationId: "delete-fixture",
      messageId: "new-message",
      expectedRevision: 0,
    });
    await page.evaluate(
      async ({ serverId, agentId }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("paseo-message-outbox", 1);
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () => reject(request.error));
        });
        const transaction = db.transaction("operations", "readwrite");
        const store = transaction.objectStore("operations");
        store.delete(JSON.stringify([serverId, agentId, "preserved-edit"]));
        const operation = {
          kind: "pause",
          operationId: "failed-pause",
          paused: false,
          expectedRevision: 0,
        };
        store.put(
          {
            version: 1,
            serverId,
            agentId,
            revision: 1,
            createdAt: Date.now(),
            operation,
            prepared: operation,
            localAttachments: [],
            error: { code: "revision_conflict", message: "The queue changed." },
          },
          JSON.stringify([serverId, agentId, operation.operationId]),
        );
        await new Promise<void>((resolve, reject) => {
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("error", () => reject(transaction.error));
        });
        db.close();
        localStorage.setItem(
          "@paseo:e2e-disable-default-seed-once",
          localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
        );
      },
      { serverId: getServerId(), agentId: agent.agentId },
    );
    await page.reload();
    await expectComposerVisible(page, { timeout: 30_000 });
    await expect(card).toContainText("Messages");
    await expect(card).toContainText("The queue changed.");
    await expect(card.getByRole("button", { name: "Retry synchronization" })).toBeVisible();
    await expect(page.getByTestId("queue-recovery-status")).toHaveCount(0);
    await test.info().attach("control-only-recovery-card", {
      body: await card.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await client.close();
    await agent.cleanup();
  }
});

for (const width of [1440, 390]) {
  test(`queue progress stays in the heading without height changes at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "queue-status-",
      title: "Queue status",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "queue-status" });
    try {
      const queue = await client.readMessageQueue(agent.agentId);
      await client.mutateMessageQueue(agent.agentId, {
        kind: "pause",
        operationId: "pause-status",
        paused: true,
        expectedRevision: queue.snapshot!.revision,
      });
      for (const id of ["first", "second"]) {
        await client.mutateMessageQueue(agent.agentId, {
          kind: "enqueue",
          operationId: `enqueue-${id}`,
          messageId: id,
          text: `Queued ${id}`,
          attachments: [],
        });
      }
      await openAgentRoute(page, agent);
      const card = page.getByTestId("shared-message-queue");
      const header = page.getByTestId("message-queue-header");
      const status = page.getByTestId("message-queue-header-status");
      await expect(card).toContainText("Queued second");
      await expect(status).toHaveText("Paused");
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        const held: (() => void)[] = [];
        WebSocket.prototype.send = function (data) {
          if (
            typeof data === "string" &&
            JSON.parse(data).message?.type === "agent.queue.mutate.request"
          ) {
            held.push(() => send.call(this, data));
          } else send.call(this, data);
        };
        Object.assign(window, {
          releaseQueueStatus: () => held.splice(0).forEach((release) => release()),
        });
      });
      const before = (await card.boundingBox())!;
      const headerBefore = (await header.boundingBox())!;
      const handle = card
        .getByRole("button", { name: "Reorder queued message", exact: true })
        .first();
      await handle.focus();
      await page.keyboard.press("Space");
      await expect(handle).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("status").filter({ hasText: "Draggable item first" }),
      ).toContainText("over droppable area second");
      await page.keyboard.press("Space");
      await expect(status).toHaveText("Paused");
      // Sample frames while the server has not received the reorder, catching a
      // return animation even if the final acknowledged order would be correct.
      const staysDropped = await card.evaluate(async (node) => {
        for (let frame = 0; frame < 30; frame++) {
          await new Promise(requestAnimationFrame);
          const rows = [...node.querySelectorAll('[data-testid^="queue-message-"]')];
          const first = rows.find((row) => row.textContent?.includes("Queued first"));
          const second = rows.find((row) => row.textContent?.includes("Queued second"));
          if (
            !first ||
            !second ||
            first.getBoundingClientRect().top <= second.getBoundingClientRect().top
          )
            return false;
        }
        return true;
      });
      expect(staysDropped).toBe(true);
      const during = (await card.boundingBox())!;
      const headerDuring = (await header.boundingBox())!;
      const statusBox = (await status.boundingBox())!;
      const actionBox = (await page.getByTestId("message-queue-pause-resume").boundingBox())!;
      expect(during.height).toBeCloseTo(before.height, 0);
      expect(headerDuring.height).toBeCloseTo(headerBefore.height, 0);
      expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(actionBox.x);
      expect(statusBox.y).toBeGreaterThanOrEqual(headerDuring.y);
      expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(
        headerDuring.y + headerDuring.height,
      );
      await test.info().attach(`queue-heading-status-${width}`, {
        body: await card.screenshot({
          path: test.info().outputPath(`queue-heading-status-${width}.png`),
        }),
        contentType: "image/png",
      });
      await page.evaluate(() =>
        (window as unknown as { releaseQueueStatus(): void }).releaseQueueStatus(),
      );
      await expect(status).toHaveText("Paused");
      expect((await card.boundingBox())!.height).toBeCloseTo(before.height, 0);

      // A mouse drop follows the same path. Change only the remote revision
      // while it is held, so rejection must explicitly undo the local preview.
      const dragged = page.getByTestId("queue-drag-second");
      const start = (await dragged.boundingBox())!;
      const target = (await page.getByTestId("queue-drag-first").boundingBox())!;
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2, target.y + target.height / 2, { steps: 12 });
      await expect(dragged).toHaveAttribute("aria-pressed", "true");
      await page.mouse.up();
      await expect
        .poll(async () => {
          const first = (await page.getByTestId("queue-message-first").boundingBox())!;
          const second = (await page.getByTestId("queue-message-second").boundingBox())!;
          return first.y < second.y;
        })
        .toBe(true);
      const current = await client.readMessageQueue(agent.agentId);
      await client.mutateMessageQueue(agent.agentId, {
        kind: "pause",
        operationId: "invalidate-reorder",
        paused: true,
        expectedRevision: current.snapshot!.revision,
      });
      await page.evaluate(() =>
        (window as unknown as { releaseQueueStatus(): void }).releaseQueueStatus(),
      );
      await expect(card.getByRole("alert").first()).toBeVisible();
      await expect
        .poll(async () => {
          const first = (await page.getByTestId("queue-message-first").boundingBox())!;
          const second = (await page.getByTestId("queue-message-second").boundingBox())!;
          return second.y < first.y;
        })
        .toBe(true);
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}
