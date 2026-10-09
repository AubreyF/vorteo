import { useFetchQuery } from "@/data/query";
import { useEffect, useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { QueueOperation } from "@getpaseo/protocol/message-queue";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";

import { generateMessageId } from "@/types/stream";
import { canRequestImmediateDelivery, type OutboxRecord } from "./outbox-record";
import {
  flushMessageOutbox,
  messageOutbox,
  messageOutboxKey,
  messageQueueKey,
  readSharedQueue,
  refreshMessageOutbox,
  watchSharedQueue,
  subscribeQueue,
} from "./runtime";

export type QueueAction = QueueOperation extends infer T
  ? T extends QueueOperation
    ? Omit<T, "operationId">
    : never
  : never;
export interface MessageOutboxState {
  records: OutboxRecord[] | null;
  error: string | null;
}

export function useMessageQueue(serverId: string, agentId: string) {
  const active = useRetainedPanelActive();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.durableMessageQueue === true,
  );
  const archived = useSessionStore(
    (state) => !!state.sessions[serverId]?.agents.get(agentId)?.archivedAt,
  );
  const activeTurnId = useSessionStore((state) => {
    const turn = state.sessions[serverId]?.agents.get(agentId)?.turn;
    return turn?.phase === "open" ? turn.turnId : null;
  });
  const enabled = active && supported && connected && !!agentId;
  const sendingNow = useRef(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const reconnectError = useFetchQuery<string | null>({
    dataShape: "value",
    queryKey: ["messageQueueSubscriptionError", serverId, agentId],
    queryFn: async () => null,
    enabled: false,
    // Runtime writes this disabled query; the fetch policy still requires a finite value.
    staleTimeMs: 0,
  });
  useEffect(() => {
    if (!enabled) return;
    setSubscriptionError(null);
    return watchSharedQueue(serverId, agentId, (error) =>
      setSubscriptionError(error instanceof Error ? error.message : "Queue subscription failed."),
    );
  }, [enabled, serverId, agentId]);
  const queue = useFetchQuery({
    dataShape: "value",
    queryKey: messageQueueKey(serverId, agentId),
    queryFn: () => readSharedQueue(serverId, agentId),
    enabled,
    retry: false,
    staleTimeMs: 0,
  });
  const outbox = useFetchQuery<MessageOutboxState>({
    dataShape: "value",
    queryKey: messageOutboxKey(serverId),
    enabled: active,
    queryFn: async () => ({
      records: (await messageOutbox.list()).filter((record) => record.serverId === serverId),
      error: null,
    }),
    refetchOnWindowFocus: true,
    staleTimeMs: 0,
    retry: false,
  });
  const immediateAllowed =
    !outbox.data?.error &&
    !outbox.error &&
    canRequestImmediateDelivery({ snapshot: queue.data, records: outbox.data?.records, agentId });
  const mutation = useMutation({
    mutationFn: async (action: QueueAction) => {
      if (!enabled || archived)
        throw new Error("Connect to the host and restore the task to change its queue.");
      const immediate = action.kind === "send_now";
      if (immediate && (sendingNow.current || !immediateAllowed))
        throw new Error("Wait for the current queue operation before sending another message now.");
      if (immediate) sendingNow.current = true;
      try {
        await messageOutbox.commit({
          serverId,
          agentId,
          createdAt: Date.now(),
          operation: { ...action, operationId: generateMessageId() },
          localAttachments: [],
        });
        await refreshMessageOutbox(serverId);
        await flushMessageOutbox(serverId);
        await queue.refetch();
      } finally {
        if (immediate) sendingNow.current = false;
      }
    },
    retry: false,
  });
  const pending = outbox.data?.records?.filter((record) => record.agentId === agentId) ?? [];
  const canMutate = enabled && !archived && !mutation.isPending && !!queue.data;
  const canSendNow = canMutate && immediateAllowed;
  return {
    visible: true,
    supported,
    connected,
    activeTurnId,
    snapshot: queue.data,
    pending,
    canSendNow,
    error: firstQueueError(
      [mutation.error, queue.error, outbox.error],
      outbox.data?.error,
      subscriptionError ?? reconnectError.data ?? null,
    ),
    loading: enabled && queue.isPending,
    busy: mutation.isPending,
    canMutate,
    mutate: mutation.mutateAsync,
    refresh: () => {
      mutation.reset();
      setSubscriptionError(null);
      void subscribeQueue(serverId, agentId, true).catch((error: unknown) =>
        setSubscriptionError(error instanceof Error ? error.message : "Queue subscription failed."),
      );
      void queue.refetch();
      void flushMessageOutbox(serverId);
    },
    retry: async (record: OutboxRecord) => {
      await messageOutbox.retry({
        serverId,
        agentId,
        operationId: record.operation.operationId,
      });
      await flushMessageOutbox(serverId);
    },
    keepLocalCopy: async (record: OutboxRecord) => {
      await messageOutbox.keepRejectedCopy({
        serverId,
        agentId,
        operationId: record.operation.operationId,
      });
      await refreshMessageOutbox(serverId);
      await flushMessageOutbox(serverId);
    },
    removeLocalCopy: async (record: OutboxRecord) => {
      await messageOutbox.removeRejectedCopy({
        serverId,
        agentId,
        operationId: record.operation.operationId,
      });
      await refreshMessageOutbox(serverId);
    },
  };
}

export type MessageQueueControl = ReturnType<typeof useMessageQueue>;

function firstQueueError(
  errors: (Error | null)[],
  stored: string | null | undefined,
  subscription: string | null,
): string | null {
  return errors.find((error) => error !== null)?.message ?? stored ?? subscription;
}
