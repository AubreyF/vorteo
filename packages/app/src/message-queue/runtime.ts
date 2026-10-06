import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { QueueSnapshot } from "@getpaseo/protocol/message-queue";
import { queryClient } from "@/data/query-client";
import { queueAttachmentStore } from "./attachment-store";
import { createOutboxStorage } from "./outbox-storage";
import { notifyOutboxChange, watchOutboxChanges } from "./outbox-notifications";
import { QueueOutbox } from "./outbox";
import { useSessionStore } from "@/stores/session-store";
import { legacyImportOperationId } from "./legacy";

export const messageQueueKey = (serverId: string, agentId: string) =>
  ["messageQueue", serverId, agentId] as const;
export const messageOutboxKey = (serverId: string) => ["messageOutbox", serverId] as const;

const clients = new Map<string, DaemonClient>();
const running = new Map<string, Promise<void>>();
const requested = new Set<string>();
const refreshGenerations = new Map<string, number>();
const watched = new Map<string, Map<string, number>>();

export async function readSharedQueue(serverId: string, agentId: string): Promise<QueueSnapshot> {
  const result = await requireQueueClient(serverId).readMessageQueue(agentId);
  if (result.error || !result.snapshot)
    throw new Error(result.error?.message ?? "Queue state is unavailable.");
  applyQueueSnapshot(serverId, result.snapshot);
  return (
    queryClient.getQueryData<QueueSnapshot>(messageQueueKey(serverId, agentId)) ?? result.snapshot
  );
}

export async function subscribeQueue(
  serverId: string,
  agentId: string,
  subscribed: boolean,
): Promise<void> {
  const result = await requireQueueClient(serverId).subscribeMessageQueue({ agentId, subscribed });
  if (result.error || !result.snapshot)
    throw new Error(result.error?.message ?? "Queue subscription failed.");
  applyQueueSnapshot(serverId, result.snapshot);
  queryClient.setQueryData(["messageQueueSubscriptionError", serverId, agentId], null);
}

export function watchSharedQueue(
  serverId: string,
  agentId: string,
  onError: (error: unknown) => void,
): () => void {
  const host = watched.get(serverId) ?? new Map<string, number>();
  watched.set(serverId, host);
  const count = host.get(agentId) ?? 0;
  host.set(agentId, count + 1);
  if (!count) void subscribeQueue(serverId, agentId, true).catch(onError);
  return () => {
    const remaining = (host.get(agentId) ?? 1) - 1;
    if (remaining) {
      host.set(agentId, remaining);
      return;
    }
    host.delete(agentId);
    if (!host.size) watched.delete(serverId);
    if (clients.get(serverId)?.isConnected)
      void subscribeQueue(serverId, agentId, false).catch(() => {});
  };
}

export function requireQueueClient(serverId: string): DaemonClient {
  const client = clients.get(serverId);
  if (!client?.isConnected) throw new Error("Connect to the host to synchronize queued messages.");
  if (!client.getLastServerInfoMessage()?.features?.durableMessageQueue)
    throw new Error("Update the host to use shared message queues.");
  return client;
}

export function applyQueueSnapshot(serverId: string, snapshot: QueueSnapshot): void {
  queryClient.setQueryData<QueueSnapshot>(messageQueueKey(serverId, snapshot.agentId), (current) =>
    current && current.revision > snapshot.revision ? current : snapshot,
  );
}

export const messageOutbox = new QueueOutbox(createOutboxStorage(), {
  localChanged: notifyOutboxChange,
  async upload(serverId, attachment) {
    const base64 = await queueAttachmentStore.encodeBase64({ attachment: attachment.metadata });
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const result = await requireQueueClient(serverId).uploadFile({
      fileName: attachment.metadata.fileName ?? `${attachment.metadata.id}.bin`,
      mimeType: attachment.metadata.mimeType,
      bytes,
    });
    if (!result.file) throw new Error(result.error ?? "The attachment could not be uploaded.");
    return { ...result.file, kind: attachment.kind };
  },
  mutate: (serverId, agentId, operation) =>
    requireQueueClient(serverId).mutateMessageQueue(agentId, operation),
  changed: (snapshot, serverId) => applyQueueSnapshot(serverId, snapshot),
  async discarded(record) {
    await Promise.allSettled(
      record.localAttachments.map(({ metadata }) =>
        queueAttachmentStore.delete({ attachment: metadata }),
      ),
    );
  },
  async acknowledged(record) {
    const operation = record.operation;
    if (
      operation.kind === "enqueue" &&
      operation.operationId === legacyImportOperationId(operation.messageId)
    ) {
      useSessionStore.getState().setQueuedMessages(record.serverId, (queues) => {
        const next = new Map(queues);
        next.set(
          record.agentId,
          (queues.get(record.agentId) ?? []).filter(
            (message) => message.id !== operation.messageId,
          ),
        );
        return next;
      });
    }
    await Promise.allSettled(
      record.localAttachments.map(({ metadata }) =>
        queueAttachmentStore.delete({ attachment: metadata }),
      ),
    );
  },
});

export async function refreshMessageOutbox(
  serverId: string,
  error: string | null = null,
): Promise<void> {
  const generation = (refreshGenerations.get(serverId) ?? 0) + 1;
  refreshGenerations.set(serverId, generation);
  const records = (await messageOutbox.list()).filter((record) => record.serverId === serverId);
  if (refreshGenerations.get(serverId) === generation)
    queryClient.setQueryData(messageOutboxKey(serverId), { records, error });
}

export function flushMessageOutbox(serverId: string): Promise<void> {
  requested.add(serverId);
  const current = running.get(serverId);
  if (current) return current;
  const run = (async () => {
    do {
      requested.delete(serverId);
      await messageOutbox.flush(serverId);
      await refreshMessageOutbox(serverId);
    } while (requested.has(serverId));
  })()
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Queue synchronization failed.";
      try {
        await refreshMessageOutbox(serverId, message);
      } catch {
        queryClient.setQueryData(messageOutboxKey(serverId), { records: null, error: message });
      }
    })
    .finally(() => {
      running.delete(serverId);
      if (requested.has(serverId)) return flushMessageOutbox(serverId);
    });
  running.set(serverId, run);
  return run;
}

export function mountMessageQueueClient(serverId: string, client: DaemonClient): () => void {
  clients.set(serverId, client);
  const stopWatchingOutbox = watchOutboxChanges((notice) => {
    if (notice.serverId !== null && notice.serverId !== serverId) return;
    void refreshMessageOutbox(serverId).catch(() => {});
    if (
      notice.flush &&
      client.isConnected &&
      client.getLastServerInfoMessage()?.features?.durableMessageQueue
    )
      void flushMessageOutbox(serverId);
  });
  // Render local pending records even when the host is offline or a request stalls.
  void refreshMessageOutbox(serverId).catch(() => {});
  let synchronized = false;
  const synchronize = () => {
    if (!client.isConnected) {
      synchronized = false;
      return;
    }
    if (synchronized || !client.getLastServerInfoMessage()?.features?.durableMessageQueue) return;
    synchronized = true;
    void flushMessageOutbox(serverId);
    for (const agentId of watched.get(serverId)?.keys() ?? []) {
      void subscribeQueue(serverId, agentId, true).catch((error: unknown) => {
        queryClient.setQueryData(
          ["messageQueueSubscriptionError", serverId, agentId],
          error instanceof Error ? error.message : "Queue subscription failed.",
        );
      });
    }
  };
  const unsubscribe = client.on("agent.queue.changed", ({ payload }) =>
    applyQueueSnapshot(serverId, payload),
  );
  const unsubscribeStatus = client.on("status", synchronize);
  const unsubscribeConnection = client.subscribeConnectionStatus(synchronize);
  synchronize();
  return () => {
    stopWatchingOutbox();
    unsubscribe();
    unsubscribeStatus();
    unsubscribeConnection();
    if (clients.get(serverId) === client) clients.delete(serverId);
  };
}
