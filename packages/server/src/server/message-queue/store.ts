import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { findQueueAcceptanceEvidence } from "./evidence.js";
import {
  QueueAcceptedMessageSchema,
  QueueIdSchema as IdSchema,
  QueueSnapshotSchema as SnapshotSchema,
  QueueOperationSchema as OperationSchema,
  type QueueOperation,
  type QueueSnapshot,
  type QueueItem,
  type QueueAttachment,
} from "@getpaseo/protocol/message-queue";

const RecordSchema = z.object({
  snapshot: SnapshotSchema,
  messageIds: z.array(IdSchema),
  receipts: z.array(
    z.object({ operationId: IdSchema, fingerprint: z.string(), revision: z.number() }),
  ),
  accepted: z.array(
    z.object({ messageId: IdSchema, attemptId: IdSchema, turnId: z.string().nullable() }),
  ),
  submissions: z.array(
    QueueAcceptedMessageSchema.extend({ restoreMissing: z.boolean().optional() }),
  ),
  providerMessageIds: z.array(z.object({ messageId: IdSchema, providerMessageId: z.string() })),
});
const OutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), turnId: z.string().nullable() }),
  z.object({ status: z.literal("failed"), reason: z.string().max(4000) }),
  z.object({ status: z.literal("uncertain"), reason: z.string().max(4000) }),
]);
interface Settlement {
  agentId: string;
  messageId: string;
  attemptId: string;
  outcome: z.infer<typeof OutcomeSchema>;
}
type QueueRecord = z.infer<typeof RecordSchema>;

export class QueueStoreError extends Error {
  constructor(
    readonly code:
      | "operation_conflict"
      | "message_conflict"
      | "revision_conflict"
      | "missing"
      | "delivery_conflict"
      | "full",
    message: string,
  ) {
    super(message);
    this.name = "QueueStoreError";
  }
}

// The daemon is the single writer. Each task's read/modify/commit belongs in this
// lane, including reads, so no caller can observe an uncommitted mutation.
export class MessageQueueStore {
  private readonly tails = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}

  private serial<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    IdSchema.parse(agentId);
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(agentId, tail);
    void tail.then(() => {
      if (this.tails.get(agentId) === tail) this.tails.delete(agentId);
      return undefined;
    });
    return result;
  }

  private path(agentId: string): string {
    return join(this.root, `${createHash("sha256").update(agentId).digest("hex")}.json`);
  }

  private async load(agentId: string): Promise<QueueRecord> {
    let text: string;
    try {
      text = await readFile(this.path(agentId), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return {
        snapshot: { agentId, revision: 0, paused: false, items: [] },
        messageIds: [],
        receipts: [],
        accepted: [],
        submissions: [],
        providerMessageIds: [],
      };
    }
    const record = RecordSchema.parse(JSON.parse(text));
    if (record.snapshot.agentId !== agentId) throw new Error("Queue identity mismatch");
    return record;
  }

  private async commit(record: QueueRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = this.path(record.snapshot.agentId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      // Windows does not support opening directories for fsync. File content is
      // flushed above; POSIX also flushes the renamed directory entry.
      if (process.platform !== "win32") {
        const directory = await open(this.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  read(agentId: string): Promise<QueueSnapshot> {
    return this.serial(agentId, async () => (await this.load(agentId)).snapshot);
  }

  /** Reserve ordinary automatic work only while no user queue operation can interleave. */
  withIdleQueue<T>(agentId: string, operation: () => Promise<T>): Promise<T | null> {
    return this.serial(agentId, async () => {
      const { snapshot } = await this.load(agentId);
      if (snapshot.paused || snapshot.items.length || snapshot.deliveryError) return null;
      return operation();
    });
  }

  attachment(input: {
    agentId: string;
    messageId: string;
    attachmentId: string;
  }): Promise<QueueAttachment | null> {
    return this.serial(input.agentId, async () => {
      const record = await this.load(input.agentId);
      const queued = record.snapshot.items.find((item) => item.id === input.messageId);
      const accepted = record.submissions.find((repair) => repair.item.id === input.messageId);
      const item = queued ?? accepted?.item;
      return item?.attachments.find((attachment) => attachment.id === input.attachmentId) ?? null;
    });
  }

  pause(agentId: string): Promise<QueueSnapshot> {
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      if (record.snapshot.paused && !record.snapshot.items.some((item) => item.sendNow))
        return record.snapshot;
      record.snapshot.paused = true;
      clearImmediateRequests(record.snapshot);
      record.snapshot.revision += 1;
      await this.commit(record);
      return record.snapshot;
    });
  }

  async listAgentIds(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const ids: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = RecordSchema.parse(JSON.parse(await readFile(join(this.root, file), "utf8")));
      if (this.path(record.snapshot.agentId) !== join(this.root, file))
        throw new Error("Queue filename does not match its task identity");
      ids.push(record.snapshot.agentId);
    }
    return ids;
  }

  setDeliveryError(agentId: string, error: string | undefined): Promise<QueueSnapshot | null> {
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      const reason = error?.slice(0, 4000);
      if (record.snapshot.deliveryError === reason) return null;
      record.snapshot.deliveryError = reason;
      record.snapshot.revision += 1;
      await this.commit(record);
      return record.snapshot;
    });
  }

  claim(agentId: string): Promise<QueueItem | null> {
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      const head = record.snapshot.items[0];
      if (!head || (record.snapshot.paused && !head.sendNow) || head.delivery.status !== "queued")
        return null;
      head.delivery = {
        status: "dispatching",
        attemptId: randomUUID(),
        startedAt: new Date().toISOString(),
      };
      head.revision += 1;
      record.snapshot.revision += 1;
      await this.commit(record);
      return head;
    });
  }

  // Only the admission owner may release an attempt, and only before invoking
  // the provider. Recovery never calls this method.
  release(agentId: string, claimed: QueueItem): Promise<QueueSnapshot> {
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      const item = record.snapshot.items.find((candidate) => candidate.id === claimed.id);
      const isCurrent =
        item?.delivery.status === "dispatching" &&
        claimed.delivery.status === "dispatching" &&
        item.delivery.attemptId === claimed.delivery.attemptId;
      if (!item || !isCurrent)
        throw new QueueStoreError("delivery_conflict", "The delivery claim is no longer current.");
      item.delivery = { status: "queued" };
      item.revision += 1;
      record.snapshot.revision += 1;
      await this.commit(record);
      return record.snapshot;
    });
  }

  acceptedHistory(agentId: string): Promise<QueueRecord["submissions"]> {
    return this.serial(agentId, async () => (await this.load(agentId)).submissions);
  }

  suppressHistoryRestoration(agentId: string, messageIds: readonly string[]): Promise<void> {
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      const ids = new Set(messageIds);
      let changed = false;
      for (const submission of record.submissions) {
        if (
          submission.restoreMissing !== false &&
          (ids.has(submission.item.id) ||
            (!!submission.providerMessageId && ids.has(submission.providerMessageId)))
        ) {
          submission.restoreMissing = false;
          changed = true;
        }
      }
      // Keep acceptance receipts and captured bytes. Rewinding must never make
      // an old enqueue retry eligible for delivery again.
      if (changed) await this.commit(record);
    });
  }

  reconcileHistory(
    agentId: string,
    history: readonly AgentStreamEvent[],
  ): Promise<{ snapshot: QueueSnapshot; changed: boolean }> {
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      let changed = false;
      for (const item of record.snapshot.items) {
        if (item.delivery.status !== "uncertain") continue;
        const nativeId = record.providerMessageIds.find(
          (entry) => entry.messageId === item.id,
        )?.providerMessageId;
        const evidence = findQueueAcceptanceEvidence(item, nativeId, history);
        if (!evidence) continue;
        record.accepted.push({
          messageId: item.id,
          attemptId: item.delivery.attemptId,
          turnId: evidence.turnId,
        });
        record.submissions.push({ item, ...evidence });
        record.snapshot.items = record.snapshot.items.filter((entry) => entry.id !== item.id);
        changed = true;
      }
      if (changed) {
        record.snapshot.revision += 1;
        await this.commit(record);
      }
      return { snapshot: record.snapshot, changed };
    });
  }

  recordProviderMessageId(input: {
    agentId: string;
    messageId: string;
    providerMessageId: string;
  }): Promise<void> {
    return this.serial(input.agentId, async () => {
      const record = await this.load(input.agentId);
      if (!record.messageIds.includes(input.messageId)) return;
      const existing = record.providerMessageIds.find(
        (entry) => entry.messageId === input.messageId,
      );
      if (existing?.providerMessageId === input.providerMessageId) return;
      if (existing) existing.providerMessageId = input.providerMessageId;
      else
        record.providerMessageIds.push({
          messageId: input.messageId,
          providerMessageId: input.providerMessageId,
        });
      const submission = record.submissions.find((entry) => entry.item.id === input.messageId);
      if (submission) submission.providerMessageId = input.providerMessageId;
      await this.commit(record);
    });
  }

  settle(input: Settlement): Promise<QueueSnapshot> {
    const outcome = OutcomeSchema.parse(input.outcome);
    return this.serial(input.agentId, async () => {
      const record = await this.load(input.agentId);
      const accepted = record.accepted.find((receipt) => receipt.messageId === input.messageId);
      if (accepted) {
        const matches =
          accepted.attemptId === input.attemptId &&
          outcome.status === "accepted" &&
          accepted.turnId === outcome.turnId;
        if (!matches)
          throw new QueueStoreError(
            "delivery_conflict",
            "The delivery result conflicts with an accepted attempt.",
          );
        return record.snapshot;
      }
      const item = record.snapshot.items.find((candidate) => candidate.id === input.messageId);
      if (
        !item ||
        item.delivery.status === "queued" ||
        item.delivery.attemptId !== input.attemptId
      ) {
        throw new QueueStoreError(
          "delivery_conflict",
          "The delivery attempt is no longer current.",
        );
      }
      if (outcome.status === "accepted") {
        record.accepted.push({
          messageId: item.id,
          attemptId: input.attemptId,
          turnId: outcome.turnId,
        });
        const providerMessageId = record.providerMessageIds.find(
          (entry) => entry.messageId === item.id,
        )?.providerMessageId;
        record.submissions.push({
          item,
          turnId: outcome.turnId,
          acceptedAt: new Date().toISOString(),
          ...(providerMessageId ? { providerMessageId } : {}),
        });
        record.snapshot.items = record.snapshot.items.filter(
          (candidate) => candidate.id !== item.id,
        );
      } else {
        const startedAt =
          "startedAt" in item.delivery ? item.delivery.startedAt : new Date().toISOString();
        if (outcome.status === "uncertain") {
          item.delivery = { ...outcome, attemptId: input.attemptId, startedAt };
        } else {
          item.delivery = { ...outcome, attemptId: input.attemptId };
        }
        item.revision += 1;
      }
      record.snapshot.revision += 1;
      await this.commit(record);
      return record.snapshot;
    });
  }

  // Bootstrap calls recovery before enabling dispatch. A persisted attempt is
  // evidence of intent, not evidence that the provider rejected the prompt.
  recover(agentId: string): Promise<QueueSnapshot> {
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      let changed = false;
      for (const item of record.snapshot.items) {
        if (item.delivery.status !== "dispatching") continue;
        item.delivery = {
          ...item.delivery,
          status: "uncertain",
          reason: "The daemon restarted before delivery was confirmed.",
        };
        item.revision += 1;
        changed = true;
      }
      if (changed) {
        record.snapshot.revision += 1;
        await this.commit(record);
      }
      return record.snapshot;
    });
  }

  mutate(
    agentId: string,
    input: QueueOperation,
    beforeCommit?: () => Promise<void>,
  ): Promise<QueueSnapshot> {
    const operation = OperationSchema.parse(input);
    if (JSON.stringify(operation).length > 1_000_000)
      throw new QueueStoreError("full", "The queued message exceeds the content limit.");
    return this.serial(agentId, async () => {
      const record = await this.load(agentId);
      const fingerprint = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
      const receipt = record.receipts.find((item) => item.operationId === operation.operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new QueueStoreError(
            "operation_conflict",
            "Operation ID was reused with different content.",
          );
        // Return current authoritative state, never roll a replica back to the
        // snapshot that existed when this operation originally committed.
        return record.snapshot;
      }
      apply(record, operation);
      record.snapshot.revision += 1;
      record.receipts.push({
        operationId: operation.operationId,
        fingerprint,
        revision: record.snapshot.revision,
      });
      // Retain authenticated ingress evidence after validation but before this
      // operation can become visible to delivery. Replays keep original evidence.
      await beforeCommit?.();
      await this.commit(record);
      return record.snapshot;
    });
  }
}

function apply(record: QueueRecord, operation: QueueOperation): void {
  const snapshot = record.snapshot;
  if (operation.kind === "reorder") {
    reorder(snapshot, operation);
    return;
  }
  if (operation.kind === "enqueue") {
    if (record.messageIds.includes(operation.messageId))
      throw new QueueStoreError("message_conflict", "This message ID has already been used.");
    if (snapshot.items.length >= 100) throw new QueueStoreError("full", "The queue is full.");
    assertContent(operation);
    snapshot.items.push({
      id: operation.messageId,
      text: operation.text,
      attachments: operation.attachments,
      ...(operation.context ? { context: operation.context } : {}),
      revision: 0,
      createdAt: new Date().toISOString(),
      delivery: { status: "queued" },
    });
    record.messageIds.push(operation.messageId);
    return;
  }
  if (operation.kind === "pause") {
    if (snapshot.revision !== operation.expectedRevision)
      throw new QueueStoreError(
        "revision_conflict",
        "The queue changed. Refresh before changing its pause state.",
      );
    snapshot.paused = operation.paused;
    if (operation.paused) clearImmediateRequests(snapshot);
    return;
  }
  const item = snapshot.items.find((candidate) => candidate.id === operation.messageId);
  if (!item) throw new QueueStoreError("missing", "The queued message no longer exists.");
  if (item.revision !== operation.expectedRevision)
    throw new QueueStoreError(
      "revision_conflict",
      "The queued message changed. Review the current version.",
    );
  if (operation.kind === "resolve") {
    const resolvable = item.delivery.status === "uncertain" || item.delivery.status === "failed";
    if (!resolvable)
      throw new QueueStoreError(
        "delivery_conflict",
        "Only failed or uncertain attempts can be resolved.",
      );
    if (operation.action === "discard") {
      snapshot.items = snapshot.items.filter((candidate) => candidate.id !== item.id);
    } else {
      item.delivery = { status: "queued" };
      delete item.sendNow;
      item.revision += 1;
    }
    return;
  }
  if (item.delivery.status !== "queued")
    throw new QueueStoreError(
      "delivery_conflict",
      "Delivery has already been attempted. Resolve its outcome before changing the message.",
    );
  if (operation.kind === "delete") {
    snapshot.items = snapshot.items.filter((candidate) => candidate.id !== operation.messageId);
    return;
  }
  if (operation.kind === "send_now") {
    if (snapshot.items.some((entry) => entry.delivery.status !== "queued" || entry.sendNow))
      throw new QueueStoreError(
        "delivery_conflict",
        "Resolve pending delivery before sending another message now.",
      );
    item.sendNow = { expectedTurnId: operation.expectedTurnId };
    item.revision += 1;
    snapshot.items = [item, ...snapshot.items.filter((entry) => entry.id !== item.id)];
    return;
  }
  assertContent(operation);
  item.text = operation.text;
  item.attachments = operation.attachments;
  item.context = operation.context;
  item.revision += 1;
}

function clearImmediateRequests(snapshot: QueueSnapshot): void {
  for (const item of snapshot.items) {
    if (item.sendNow) {
      delete item.sendNow;
      item.revision += 1;
    }
  }
}

function reorder(
  snapshot: QueueSnapshot,
  operation: Extract<QueueOperation, { kind: "reorder" }>,
): void {
  if (snapshot.revision !== operation.expectedRevision)
    throw new QueueStoreError("revision_conflict", "The queue changed. Review its current order.");
  if (snapshot.items.some((item) => item.delivery.status !== "queued"))
    throw new QueueStoreError("delivery_conflict", "Resolve pending delivery before reordering.");
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const uniqueIds = new Set(operation.messageIds);
  const sameMembers =
    uniqueIds.size === operation.messageIds.length && uniqueIds.size === byId.size;
  if (!sameMembers)
    throw new QueueStoreError(
      "message_conflict",
      "Reordering must include each queued message once.",
    );
  snapshot.items = operation.messageIds.map((id) => {
    const item = byId.get(id);
    if (!item)
      throw new QueueStoreError("message_conflict", "Reordering contains an unknown message.");
    return item;
  });
}

function assertContent(content: Pick<QueueItem, "text" | "attachments" | "context">): void {
  const hasContent =
    content.text.trim().length > 0 ||
    content.attachments.length > 0 ||
    (content.context?.length ?? 0) > 0;
  if (!hasContent) throw new QueueStoreError("missing", "A message needs text or attachments.");
}
