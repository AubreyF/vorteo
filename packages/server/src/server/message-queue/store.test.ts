import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MessageQueueStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("refuses queue visibility when ingress evidence cannot be retained", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-ingress-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  const operation = {
    kind: "enqueue" as const,
    operationId: "add",
    messageId: "message",
    text: "Draft only",
    attachments: [],
  };
  await expect(
    store.mutate("agent", operation, async () => {
      throw new Error("evidence unavailable");
    }),
  ).rejects.toThrow("evidence unavailable");
  expect((await store.read("agent")).items).toEqual([]);
  let calls = 0;
  await store.mutate("agent", operation, async () => {
    calls++;
  });
  await new MessageQueueStore(root).mutate("agent", operation, async () => {
    throw new Error("replay must retain original attribution");
  });
  expect(calls).toBe(1);
  expect((await store.read("agent")).items).toHaveLength(1);
});

it("reconciles an uncertain attempt only from provider identity and retains its captured content", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-evidence-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  await store.mutate("agent", {
    kind: "enqueue",
    operationId: "add",
    messageId: "message",
    text: "Inspect",
    attachments: [],
  });
  await store.claim("agent");
  await store.recover("agent");
  expect((await store.reconcileHistory("agent", [])).changed).toBe(false);
  const result = await store.reconcileHistory("agent", [
    {
      type: "timeline",
      provider: "codex",
      turnId: "turn",
      item: {
        type: "user_message",
        clientMessageId: "message",
        messageId: "native",
        text: "Provider-rendered prompt",
      },
    },
  ]);
  expect(result.changed).toBe(true);
  expect(result.snapshot.items).toEqual([]);
  const restarted = new MessageQueueStore(root);
  expect(await restarted.acceptedHistory("agent")).toMatchObject([
    { item: { id: "message", text: "Inspect" }, providerMessageId: "native", turnId: "turn" },
  ]);
});

it("prioritizes send now without resuming the queue and clears its intent on stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-send-now-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  for (const id of ["first", "selected"])
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: id,
      messageId: id,
      text: id,
      attachments: [],
    });
  await store.pause("agent");
  const request = {
    kind: "send_now" as const,
    operationId: "send",
    messageId: "selected",
    expectedRevision: 0,
    expectedTurnId: "observed-turn",
  };
  const sent = await store.mutate("agent", request);
  expect(sent.paused).toBe(true);
  expect(sent.items.map((item) => item.id)).toEqual(["selected", "first"]);
  expect((await store.mutate("agent", request)).revision).toBe(sent.revision);
  const claimed = await store.claim("agent");
  expect(claimed?.sendNow).toEqual({ expectedTurnId: "observed-turn" });
  if (!claimed) throw new Error("Expected the selected message claim");
  await store.pause("agent");
  await store.release("agent", claimed);
  expect((await store.read("agent")).items[0].sendNow).toBeUndefined();
  expect(await store.claim("agent")).toBeNull();
});

it("preserves context-only queued messages across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-context-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  const context = [
    {
      type: "text" as const,
      mimeType: "text/plain" as const,
      text: "Captured selection",
      title: "Selection",
    },
  ];
  await store.mutate("agent", {
    kind: "enqueue",
    operationId: "add",
    messageId: "message",
    text: "",
    context,
    attachments: [],
  });
  const restarted = new MessageQueueStore(root);
  expect((await restarted.read("agent")).items[0].context).toEqual(context);
});

it("serializes concurrent edits and does not resurrect a deleted message on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  const enqueue = {
    kind: "enqueue" as const,
    operationId: "add",
    messageId: "message",
    text: "original",
    attachments: [],
  };
  await store.mutate("agent", enqueue);
  const edit = {
    kind: "edit" as const,
    messageId: "message",
    expectedRevision: 0,
    attachments: [],
  };
  const outcomes = await Promise.allSettled([
    store.mutate("agent", { ...edit, operationId: "edit-a", text: "first" }),
    store.mutate("agent", { ...edit, operationId: "edit-b", text: "second" }),
  ]);
  expect(outcomes[0].status).toBe("fulfilled");
  expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "revision_conflict" } });
  await store.mutate("agent", {
    kind: "delete",
    operationId: "delete",
    messageId: "message",
    expectedRevision: 1,
  });
  const restarted = new MessageQueueStore(root);
  expect((await restarted.mutate("agent", enqueue)).items).toEqual([]);
  await expect(
    restarted.mutate("agent", { ...enqueue, operationId: "new-add" }),
  ).rejects.toMatchObject({ code: "message_conflict" });
});

it("preserves acknowledged messages and enqueue receipts across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-"));
  roots.push(root);
  const operation = {
    operationId: "op-1",
    kind: "enqueue" as const,
    messageId: "message-1",
    text: "Continue the investigation",
    attachments: [],
  };
  const store = new MessageQueueStore(root);
  const accepted = await store.mutate("agent-1", operation);
  const restarted = new MessageQueueStore(root);
  expect(await restarted.read("agent-1")).toEqual(accepted);
  expect(await restarted.mutate("agent-1", operation)).toEqual(accepted);
  expect(accepted.items).toHaveLength(1);
  await expect(
    restarted.mutate("agent-1", { ...operation, text: "different intent" }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
});

it("persists a delivery claim and blocks retry after an ambiguous restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  await store.mutate("agent", {
    kind: "enqueue",
    operationId: "add",
    messageId: "message",
    text: "run once",
    attachments: [],
  });
  const attempt = await store.claim("agent");
  expect(attempt).toMatchObject({ id: "message", delivery: { status: "dispatching" } });
  expect(await store.claim("agent")).toBeNull();
  const restarted = new MessageQueueStore(root);
  const recovered = await restarted.recover("agent");
  expect(recovered.items[0].delivery).toMatchObject({ status: "uncertain" });
  expect(await restarted.claim("agent")).toBeNull();
  await expect(
    restarted.mutate("agent", {
      kind: "delete",
      operationId: "delete",
      messageId: "message",
      expectedRevision: recovered.items[0].revision,
    }),
  ).rejects.toMatchObject({ code: "delivery_conflict" });
});

it("retains accepted payload for timeline repair and rejects stale delivery results", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  await store.mutate("agent", {
    kind: "enqueue",
    operationId: "add",
    messageId: "message",
    text: "run once",
    attachments: [],
  });
  const item = await store.claim("agent");
  if (!item || item.delivery.status !== "dispatching")
    throw new Error("Expected a claimed message");
  await expect(
    store.settle({
      agentId: "agent",
      messageId: "message",
      attemptId: "wrong-attempt",
      outcome: { status: "accepted", turnId: "turn" },
    }),
  ).rejects.toMatchObject({ code: "delivery_conflict" });
  const restarted = new MessageQueueStore(root);
  await restarted.recover("agent");
  const accepted = await restarted.settle({
    agentId: "agent",
    messageId: "message",
    attemptId: item.delivery.attemptId,
    outcome: { status: "accepted", turnId: "turn" },
  });
  expect(accepted.items).toEqual([]);
  expect(await restarted.acceptedHistory("agent")).toMatchObject([
    { item: { id: "message", text: "run once" }, turnId: "turn" },
  ]);
  expect(await new MessageQueueStore(root).acceptedHistory("agent")).toHaveLength(1);
  expect(
    (
      await restarted.settle({
        agentId: "agent",
        messageId: "message",
        attemptId: item.delivery.attemptId,
        outcome: { status: "accepted", turnId: "turn" },
      })
    ).items,
  ).toEqual([]);
});

it("persists pause and order, and requires explicit resolution before retrying uncertain delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  for (const id of ["a", "b"])
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: `add-${id}`,
      messageId: id,
      text: id,
      attachments: [],
    });
  await store.mutate("agent", {
    kind: "reorder",
    operationId: "order",
    messageIds: ["b", "a"],
    expectedRevision: 2,
  });
  await store.mutate("agent", {
    kind: "pause",
    operationId: "pause",
    paused: true,
    expectedRevision: 3,
  });
  const restarted = new MessageQueueStore(root);
  expect(await restarted.claim("agent")).toBeNull();
  await restarted.mutate("agent", {
    kind: "pause",
    operationId: "resume",
    paused: false,
    expectedRevision: 4,
  });
  const first = await restarted.claim("agent");
  if (!first || first.delivery.status !== "dispatching") throw new Error("Expected claimed head");
  expect(first.id).toBe("b");
  const recovery = await restarted.recover("agent");
  await restarted.mutate("agent", {
    kind: "resolve",
    operationId: "retry",
    messageId: "b",
    expectedRevision: recovery.items[0].revision,
    action: "retry",
  });
  const second = await restarted.claim("agent");
  if (!second || second.delivery.status !== "dispatching") throw new Error("Expected retry");
  expect(second.delivery.attemptId).not.toBe(first.delivery.attemptId);
  await expect(
    restarted.settle({
      agentId: "agent",
      messageId: "b",
      attemptId: first.delivery.attemptId,
      outcome: { status: "accepted", turnId: "old" },
    }),
  ).rejects.toMatchObject({ code: "delivery_conflict" });
});

it("persists rewind suppression without erasing delivery receipts or earlier history", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-rewind-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  for (const id of ["earlier", "rewound"]) {
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: id,
      messageId: id,
      text: id,
      attachments: [],
    });
    const item = await store.claim("agent");
    if (item?.delivery.status !== "dispatching") throw new Error("Expected claim");
    await store.settle({
      agentId: "agent",
      messageId: id,
      attemptId: item.delivery.attemptId,
      outcome: { status: "accepted", turnId: id },
    });
    await store.recordProviderMessageId({
      agentId: "agent",
      messageId: id,
      providerMessageId: `native-${id}`,
    });
  }
  await store.suppressHistoryRestoration("agent", ["native-rewound"]);
  const restarted = new MessageQueueStore(root);
  const history = await restarted.acceptedHistory("agent");
  expect(history[0].restoreMissing).toBeUndefined();
  expect(history[1].restoreMissing).toBe(false);
  await restarted.mutate("agent", {
    kind: "enqueue",
    operationId: "rewound",
    messageId: "rewound",
    text: "rewound",
    attachments: [],
  });
  expect((await restarted.read("agent")).items).toEqual([]);
});

it("retains an uncertain dispatch behind restart readiness without replay or idle admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-restart-uncertain-"));
  roots.push(root);
  const store = new MessageQueueStore(root);
  await store.mutate("agent", {
    kind: "enqueue",
    operationId: "enqueue",
    messageId: "message",
    text: "Existing work",
    attachments: [],
  });
  expect(await store.claim("agent")).not.toBeNull();
  const owner = "8eebd9f4-90f5-4f69-a5ce-6db9891642f2";
  await store.captureRestartContinuation("agent", "request", owner);
  const reopened = new MessageQueueStore(root);
  await reopened.recover("agent");
  expect(await reopened.withIdleQueue("agent", async () => "unexpected")).toBeNull();
  expect(await reopened.claim("agent")).toBeNull();
  // A replacement lifetime may cancel the dead owner's cause; that only releases admission.
  await reopened.releaseRestartContinuation("agent", "request", "cancelled");
  await reopened.releaseRestartContinuation("agent", "request", "ready");
  expect((await reopened.read("agent")).items[0].delivery.status).toBe("uncertain");
  expect(await reopened.claim("agent")).toBeNull();
  await reopened.captureRestartContinuation("agent", "request", owner);
  expect(await reopened.restartContinuation("agent")).toMatchObject({
    phase: "cancelled",
    requestId: "request",
  });
});
