import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { QueueSnapshot } from "@getpaseo/protocol/message-queue";
import { QueueAttachmentStore } from "./attachments.js";
import { MessageQueueStore } from "./store.js";
import { MessageQueueService } from "./service.js";
import {
  pauseGoalForQueue,
  resumeGoalAfterQueue,
  type QueueGoalHold,
  type QueueGoalPort,
} from "./goal-hold.js";
import type { AgentGoal } from "@getpaseo/protocol/agent-goals";

it("shares committed changes across subscribers and preserves the queue after they close", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-service-"));
  try {
    const service = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    const first: QueueSnapshot[] = [];
    const second: QueueSnapshot[] = [];
    const closeFirst = service.subscribe("agent", (snapshot) => first.push(snapshot));
    const closeSecond = service.subscribe("agent", (snapshot) => second.push(snapshot));
    await service.mutate("agent", {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "continue",
      attachments: [],
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    closeFirst();
    closeSecond();
    const restarted = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    expect((await restarted.read("agent")).items).toMatchObject([
      { id: "message", text: "continue" },
    ]);
    await restarted.mutate("agent", {
      kind: "edit",
      operationId: "edit",
      messageId: "message",
      expectedRevision: 0,
      text: "new content",
      attachments: [],
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reconciles unfinished delivery before exposing a restarted queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-recovery-"));
  try {
    const store = new MessageQueueStore(root);
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "continue",
      attachments: [],
    });
    await store.claim("agent");
    const restarted = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    expect((await restarted.read("agent")).items[0].delivery.status).toBe("uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retries and clears an empty queue's persisted completion error", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-completion-retry-"));
  const store = new MessageQueueStore(root);
  const service = new MessageQueueService(store, new QueueAttachmentStore(root));
  try {
    await store.setDeliveryError("agent", "Goal confirmation pending");
    let blocked = true;
    let observedBlock = false;
    await service.startDelivery({
      prepare: async () => true,
      load: async (item) => item.text,
      start: () => null,
      complete: async () => {
        if (blocked) throw new Error("Goal confirmation pending");
      },
      failed: () => {
        observedBlock = true;
      },
    });
    await expect.poll(() => observedBlock).toBe(true);
    expect((await service.read("agent")).deliveryError).toBe("Goal confirmation pending");
    blocked = false;
    const snapshot = await service.read("agent");
    await service.mutate("agent", {
      kind: "pause",
      operationId: "retry",
      paused: false,
      expectedRevision: snapshot.revision,
    });
    await expect.poll(async () => (await service.read("agent")).deliveryError).toBeUndefined();
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["queue pause", "task stop"] as const)(
  "%s during native goal suspension preserves the correct continuation owner",
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-queue-goal-race-"));
    const store = new MessageQueueStore(root);
    const service = new MessageQueueService(store, new QueueAttachmentStore(root));
    let hold: QueueGoalHold | undefined;
    let goal: AgentGoal = {
      threadId: "thread",
      objective: "Finish",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    let releasePause!: () => void;
    const pausePending = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    let enteredPause!: () => void;
    const pauseEntered = new Promise<void>((resolve) => {
      enteredPause = resolve;
    });
    let starts = 0;
    const errors: unknown[] = [];
    const read: QueueGoalPort["read"] = async () => ({
      status: "ready",
      goal,
      observedAt: new Date(0).toISOString(),
    });
    const base = {
      hold: () => hold,
      persist: async (value: QueueGoalHold | undefined) => {
        hold = value;
      },
      read,
      set: async (status: "active" | "paused") => {
        if (status === "paused") {
          enteredPause();
          await pausePending;
        }
        goal = { ...goal, status, updatedAt: goal.updatedAt + 1 };
        return read();
      },
    };
    try {
      await service.mutate("agent", {
        kind: "enqueue",
        operationId: "enqueue",
        messageId: "message",
        text: "Inspect",
        attachments: [],
      });
      await service.startDelivery({
        needsCompletion: () => !!hold,
        abandonGoal: async () => {
          hold = undefined;
        },
        prepare: async (_id, _item, canStart, canHoldGoal = canStart) => {
          await pauseGoalForQueue({
            ...base,
            canPause: canHoldGoal,
            mayResume: async () => false,
            mayRemainActive: async () => false,
          });
          return canStart();
        },
        complete: async (_id, allowed, canContinue = () => true) => {
          await resumeGoalAfterQueue({
            ...base,
            canPause: canContinue,
            mayResume: allowed,
            mayRemainActive: allowed,
          });
        },
        load: async (item) => item.text,
        start: () => {
          starts++;
          return null;
        },
        failed: (error) => {
          errors.push(error);
        },
      });
      await pauseEntered;
      if (action === "task stop") await service.pause("agent");
      else
        await service.mutate("agent", {
          kind: "pause",
          operationId: "pause",
          paused: true,
          expectedRevision: (await service.read("agent")).revision,
        });
      releasePause();
      await expect
        .poll(
          () =>
            hold === undefined && goal.status === (action === "queue pause" ? "active" : "paused"),
        )
        .toBe(true);
      expect(starts).toBe(0);
      expect((await service.read("agent")).items).toMatchObject([
        { id: "message", delivery: { status: "queued" } },
      ]);
      expect((await service.read("agent")).paused).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      releasePause();
      service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("allows goal continuation after restarting with a paused nonempty queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-paused-goal-restart-"));
  const store = new MessageQueueStore(root);
  const service = new MessageQueueService(
    new MessageQueueStore(root),
    new QueueAttachmentStore(root),
  );
  try {
    const queued = await store.mutate("agent", {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "Later",
      attachments: [],
    });
    await store.mutate("agent", {
      kind: "pause",
      operationId: "pause",
      paused: true,
      expectedRevision: queued.revision,
    });
    let canResume = false;
    let starts = 0;
    await service.startDelivery({
      prepare: async () => true,
      load: async (item) => item.text,
      start: () => {
        starts++;
        return null;
      },
      complete: async (_agent, eligible, canContinue) => {
        canResume = !!canContinue?.() && (await eligible());
      },
      failed: (error) => {
        throw error;
      },
    });
    await expect.poll(() => canResume).toBe(true);
    expect(starts).toBe(0);
    expect((await service.read("agent")).items).toHaveLength(1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("recovers held goals without a stored message queue after daemon replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-held-goal-recovery-"));
  const service = new MessageQueueService(
    new MessageQueueStore(root),
    new QueueAttachmentStore(root),
  );
  const recovered: string[] = [];
  try {
    await service.startDelivery({
      recoveryAgentIds: async () => ["held-goal"],
      prepare: async () => true,
      load: async (item) => item.text,
      start: () => null,
      complete: async (id, eligible) => {
        if (await eligible()) recovered.push(id);
      },
      failed: (error) => {
        throw error;
      },
    });
    await expect.poll(() => recovered).toEqual(["held-goal"]);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("persists one restart continuation and respects a manually paused queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-restart-continuation-"));
  const service = new MessageQueueService(
    new MessageQueueStore(root),
    new QueueAttachmentStore(root),
  );
  try {
    await service.queueRestartContinuation("thread", "restart");
    await service.queueRestartContinuation("thread", "restart");
    await service.pause("paused-thread");
    await service.queueRestartContinuation("paused-thread", "restart");
    service.close();
    const recovered = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    expect((await recovered.read("thread")).items).toHaveLength(1);
    expect((await recovered.read("paused-thread")).items).toHaveLength(0);
    const attempted: string[] = [];
    let held = true;
    await recovered.startDelivery({
      canStartWork: () => !held,
      prepare: async () => true,
      load: async (item) => item.text,
      start: (id) => {
        attempted.push(id);
        return null;
      },
      failed: (error) => {
        throw error;
      },
    });
    expect(attempted).toEqual([]);
    held = false;
    recovered.wake("thread");
    await expect.poll(() => attempted).toEqual(["thread"]);
    recovered.close();
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["pause", "enqueue", "close"] as const)(
  "withdraws automatic review admission when %s arrives during preparation",
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-review-race-"));
    const service = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    try {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const admission = service.withIdleQueue("agent", async (canStart) => {
        expect(canStart()).toBe(true);
        entered.resolve();
        await release.promise;
        return canStart();
      });
      await entered.promise;
      let mutation: Promise<unknown>;
      if (action === "pause") mutation = service.pause("agent");
      else if (action === "enqueue")
        mutation = service.mutate("agent", {
          kind: "enqueue",
          operationId: "owner-add",
          messageId: "owner-message",
          text: "Keep this owner message",
          attachments: [],
        });
      else {
        service.close();
        mutation = Promise.resolve();
      }
      release.resolve();
      expect(await admission).toBe(false);
      await mutation;
      expect(await service.withIdleQueue("agent", async () => "started")).toBe(null);
      if (action === "enqueue") {
        expect((await service.read("agent")).items).toMatchObject([
          { id: "owner-message", text: "Keep this owner message" },
        ]);
      }
    } finally {
      service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("holds automatic review while an empty queue has an unresolved delivery error", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-review-error-"));
  const store = new MessageQueueStore(root);
  const service = new MessageQueueService(store, new QueueAttachmentStore(root));
  try {
    await service.initialize();
    await store.setDeliveryError("agent", "Delivery confirmation unresolved");
    expect(await service.withIdleQueue("agent", async () => "started")).toBe(null);
    expect((await service.read("agent")).deliveryError).toBe("Delivery confirmation unresolved");
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
