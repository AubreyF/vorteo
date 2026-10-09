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
        body: await card.screenshot(),
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
