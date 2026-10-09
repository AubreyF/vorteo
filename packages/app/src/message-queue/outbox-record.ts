import { z } from "zod";
import { QueueOperationSchema, type QueueSnapshot } from "@getpaseo/protocol/message-queue";

export const LocalQueueAttachmentSchema = z.object({
  kind: z.enum(["image", "file"]),
  metadata: z.object({
    id: z.string(),
    mimeType: z.string(),
    storageType: z.enum(["web-indexeddb", "desktop-file", "native-file"]),
    storageKey: z.string(),
    fileName: z.string().nullable().optional(),
    byteSize: z.number().nonnegative().nullable().optional(),
    createdAt: z.number(),
  }),
});

// This is user data, not a replica cache. Unknown formats must fail visibly, never reset.
export const OutboxRecordSchema = z.object({
  version: z.literal(1),
  serverId: z.string().min(1),
  agentId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  createdAt: z.number(),
  order: z.number().int().nonnegative().optional(),
  operation: QueueOperationSchema,
  localAttachments: z.array(LocalQueueAttachmentSchema).max(32),
  prepared: QueueOperationSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  dismissed: z.boolean().optional(),
});

export type LocalQueueAttachment = z.infer<typeof LocalQueueAttachmentSchema>;
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;

interface ImmediateDeliveryState {
  snapshot: QueueSnapshot | undefined;
  records: OutboxRecord[] | null | undefined;
  agentId: string;
}

export function canRequestImmediateDelivery({
  snapshot,
  records,
  agentId,
}: ImmediateDeliveryState): boolean {
  if (!snapshot || !records || !snapshot.items.length) return false;
  const deliveryPending = snapshot.items.some(
    (item) => item.delivery.status !== "queued" || item.sendNow,
  );
  const localPending = records.some((record) => record.agentId === agentId && !record.dismissed);
  return !deliveryPending && !localPending;
}

export function canKeepRejectedChange(record: OutboxRecord): boolean {
  if (record.operation.kind === "enqueue" || record.dismissed || !record.error) return false;
  return ["revision_conflict", "delivery_conflict", "missing", "message_conflict", "full"].includes(
    record.error.code,
  );
}
export type OutboxKey = Pick<OutboxRecord, "serverId" | "agentId"> & { operationId: string };

export function outboxKey(record: OutboxRecord): OutboxKey {
  return {
    serverId: record.serverId,
    agentId: record.agentId,
    operationId: record.operation.operationId,
  };
}

export function encodeOutboxKey(key: OutboxKey): string {
  return JSON.stringify([key.serverId, key.agentId, key.operationId]);
}

export interface OutboxStorage {
  list(): Promise<OutboxRecord[]>;
  read(key: OutboxKey): Promise<OutboxRecord | null>;
  // The comparison and write share a durable transaction across browser tabs.
  // A false result means another client changed or acknowledged the record.
  exchange(
    key: OutboxKey,
    expectedRevision: number | null,
    value: OutboxRecord | null,
  ): Promise<boolean>;
}

export function validateOutboxExchange(
  key: OutboxKey,
  expectedRevision: number | null,
  value: OutboxRecord | null,
): void {
  if (!value) return;
  OutboxRecordSchema.parse(value);
  if (
    encodeOutboxKey(key) !== encodeOutboxKey(outboxKey(value)) ||
    value.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)
  ) {
    throw new Error("Invalid outbox record identity or revision");
  }
}

// Allocated inside the insertion transaction, so clocks and random IDs cannot
// reorder same-millisecond commits or messages saved by another browser tab.
export function nextOutboxOrder(records: OutboxRecord[]): number {
  return (
    records.reduce((latest, record) => Math.max(latest, record.order ?? record.createdAt), 0) + 1
  );
}
