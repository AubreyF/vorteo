import type { QueueOperation, QueueSnapshot } from "@getpaseo/protocol/message-queue";
import { QueueAttachmentStore } from "./attachments.js";
import { MessageQueueStore, QueueStoreError } from "./store.js";
import { QueueDeliveryWorker, type QueueDeliveryPort } from "./delivery.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

type QueueListener = (snapshot: QueueSnapshot) => void;

/** One instance belongs to the daemon. Subscriptions never own stored messages. */
export class MessageQueueService {
  private readonly listeners = new Map<string, Set<QueueListener>>();
  private readonly queuedAgents = new Set<string>();
  private closed = false;
  private readonly automaticAdmissionEpoch = new Map<string, number>();
  private readonly automaticAdmissionBusy = new Map<string, number>();
  private initialization: Promise<void> | null = null;
  private delivery: QueueDeliveryWorker | null = null;
  private deliveryPort: Omit<QueueDeliveryPort, "changed"> | null = null;
  private readonly stopGenerations = new Map<string, number>();
  constructor(
    private readonly store: MessageQueueStore,
    private readonly attachments: QueueAttachmentStore,
  ) {}

  async startDelivery(port: Omit<QueueDeliveryPort, "changed">): Promise<void> {
    await this.initialize();
    if (this.delivery) throw new Error("Queue delivery is already started");
    this.deliveryPort = port;
    this.delivery = new QueueDeliveryWorker(this.store, {
      ...port,
      changed: (snapshot) => this.publish(snapshot),
    });
    const stored = await this.store.listAgentIds();
    const held = (await port.recoveryAgentIds?.()) ?? [];
    for (const agentId of new Set([...stored, ...held])) void this.delivery.wake(agentId);
  }

  async queueRestartContinuation(agentId: string, requestId: string): Promise<void> {
    const snapshot = await this.read(agentId);
    // Existing queued work already supplies continuation. User-paused queues stay paused.
    if (snapshot.paused || snapshot.items.length) return;
    const id = `restart-${requestId}-${agentId}`;
    await this.mutate(agentId, {
      kind: "enqueue",
      operationId: id,
      messageId: id,
      attachments: [],
      text: "The installation restart hold has ended. Continue the work you saved for this restart, following the owner's latest instructions.",
    });
  }

  wake(agentId: string): void {
    if (this.queuedAgents.has(agentId) || this.deliveryPort?.needsCompletion?.(agentId))
      void this.delivery?.wake(agentId);
  }

  close(): void {
    this.closed = true;
    this.delivery?.close();
  }

  async pause(agentId: string): Promise<void> {
    return this.trackQueueMutation(agentId, () => this.pauseQueued(agentId));
  }

  private async pauseQueued(agentId: string): Promise<void> {
    this.delivery?.halt(agentId);
    this.stopGenerations.set(agentId, (this.stopGenerations.get(agentId) ?? 0) + 1);
    await this.deliveryPort?.abandonGoal?.(agentId);
    await this.initialize();
    this.publish(await this.store.pause(agentId));
  }

  initialize(): Promise<void> {
    this.initialization ??= this.recover();
    return this.initialization;
  }

  private async recover(): Promise<void> {
    for (const agentId of await this.store.listAgentIds()) {
      this.publish(await this.store.recover(agentId));
    }
  }

  async read(agentId: string): Promise<QueueSnapshot> {
    await this.initialize();
    return this.store.read(agentId);
  }

  async acceptedHistory(agentId: string) {
    await this.initialize();
    return this.store.acceptedHistory(agentId);
  }

  async suppressHistoryRestoration(agentId: string, messageIds: readonly string[]): Promise<void> {
    await this.initialize();
    await this.store.suppressHistoryRestoration(agentId, messageIds);
  }

  async reconcileHistory(agentId: string, history: readonly AgentStreamEvent[]): Promise<void> {
    await this.initialize();
    const result = await this.store.reconcileHistory(agentId, history);
    if (result.changed) {
      this.publish(result.snapshot);
      this.wake(agentId);
    }
  }

  async recordProviderMessageId(input: {
    agentId: string;
    messageId: string;
    providerMessageId: string;
  }): Promise<void> {
    await this.initialize();
    await this.store.recordProviderMessageId(input);
  }

  async attachment(input: { agentId: string; messageId: string; attachmentId: string }) {
    await this.initialize();
    const attachment = await this.store.attachment(input);
    if (!attachment)
      throw new QueueStoreError("missing", "The attachment is not part of this message.");
    const location = await this.attachments.location(attachment);
    return { attachment, ...location };
  }

  private async trackQueueMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    this.automaticAdmissionEpoch.set(agentId, (this.automaticAdmissionEpoch.get(agentId) ?? 0) + 1);
    this.automaticAdmissionBusy.set(agentId, (this.automaticAdmissionBusy.get(agentId) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.automaticAdmissionBusy.get(agentId) ?? 1) - 1;
      if (remaining) this.automaticAdmissionBusy.set(agentId, remaining);
      else this.automaticAdmissionBusy.delete(agentId);
    }
  }

  async withIdleQueue<T>(
    agentId: string,
    operation: (canStart: () => boolean) => Promise<T>,
  ): Promise<T | null> {
    const epoch = this.automaticAdmissionEpoch.get(agentId) ?? 0;
    const canStart = () =>
      !this.closed &&
      !this.automaticAdmissionBusy.has(agentId) &&
      epoch === (this.automaticAdmissionEpoch.get(agentId) ?? 0);
    await this.initialize();
    if (!canStart()) return null;
    return this.store.withIdleQueue(agentId, async () => {
      if (!canStart()) return null;
      return operation(canStart);
    });
  }

  async mutate(
    agentId: string,
    operation: QueueOperation,
    beforeCommit?: () => Promise<void>,
  ): Promise<QueueSnapshot> {
    return this.trackQueueMutation(agentId, () =>
      this.mutateQueued(agentId, operation, beforeCommit),
    );
  }

  private async mutateQueued(
    agentId: string,
    operation: QueueOperation,
    beforeCommit?: () => Promise<void>,
  ): Promise<QueueSnapshot> {
    await this.initialize();
    const generation = this.stopGenerations.get(agentId) ?? 0;
    const pauseRequested = operation.kind === "pause" && operation.paused;
    const releaseSuspension = pauseRequested ? this.delivery?.suspend(agentId) : undefined;
    let snapshot: QueueSnapshot;
    try {
      if (operation.kind === "enqueue" || operation.kind === "edit")
        await this.attachments.capture(operation.attachments);
      snapshot = await this.store.mutate(agentId, operation, beforeCommit);
    } catch (error) {
      releaseSuspension?.();
      this.wake(agentId);
      throw error;
    }
    releaseSuspension?.();
    this.publish(snapshot);
    this.resumeAfterMutation(agentId, operation, snapshot, generation);
    this.wake(agentId);
    return snapshot;
  }

  private resumeAfterMutation(
    agentId: string,
    operation: QueueOperation,
    snapshot: QueueSnapshot,
    generation: number,
  ): void {
    const currentGeneration = this.stopGenerations.get(agentId) ?? 0;
    if (operation.kind === "pause" && !operation.paused && generation === currentGeneration)
      this.delivery?.resume(agentId);
    if (
      operation.kind === "send_now" &&
      snapshot.items[0]?.sendNow &&
      generation === currentGeneration
    ) {
      this.delivery?.resume(agentId);
      void this.delivery?.wakeImmediate(agentId);
    }
  }

  // Register before reading the initial snapshot. Changes may precede the read
  // response; clients retain the highest revision, so reconnect has no gap.
  subscribe(agentId: string, listener: QueueListener): () => void {
    let listeners = this.listeners.get(agentId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(agentId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(agentId);
    };
  }

  private publish(snapshot: QueueSnapshot): void {
    if (snapshot.items.length > 0 || snapshot.deliveryError)
      this.queuedAgents.add(snapshot.agentId);
    else this.queuedAgents.delete(snapshot.agentId);
    const listeners = this.listeners.get(snapshot.agentId);
    if (!listeners) return;
    for (const listener of listeners) listener(structuredClone(snapshot));
  }
}
