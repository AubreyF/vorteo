import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useFetchQuery } from "@/data/query";
import type { QueueItem } from "@getpaseo/protocol/message-queue";

import { queueEditDraftSession, queueEditDraftStorage } from "./edit-draft-runtime";
import type { QueueEditDraft } from "./edit-draft";

interface DraftContext {
  drafts: QueueEditDraft[];
  refresh(): Promise<unknown>;
  open(item: QueueItem): Promise<void>;
  error: Error | null;
}
const Context = createContext<DraftContext | null>(null);
export function QueueEditDraftProvider({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId: string;
  children: ReactNode;
}) {
  const query = useFetchQuery<QueueEditDraft[]>({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["queueEditDrafts", serverId, agentId],
    queryFn: async () =>
      (await queueEditDraftStorage.list()).filter(
        (draft) => draft.serverId === serverId && draft.agentId === agentId,
      ),
    enabled: true,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const { data, error, refetch } = query;
  const value = useMemo<DraftContext>(
    () => ({
      drafts: data ?? [],
      error,
      refresh: refetch,
      open: async (item) => {
        await queueEditDraftSession.open(serverId, agentId, item);
        await refetch();
      },
    }),
    [data, error, refetch, serverId, agentId],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useQueueEditDrafts(): DraftContext {
  const context = useContext(Context);
  if (!context) throw new Error("Queue edit drafts require their provider.");
  return context;
}
