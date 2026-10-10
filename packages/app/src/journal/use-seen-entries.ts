import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { journalSeenKey, parseSeenEntries, rememberSeenEntries } from "./seen-state";

export function useSeenEntries(serverId: string, agentId: string) {
  const storageKey = journalSeenKey(serverId, agentId);
  const [saveFailed, setSaveFailed] = useState(false);
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["journal-seen", storageKey],
    queryFn: async () => parseSeenEntries(await AsyncStorage.getItem(storageKey)),
  });
  const save = useMutation({
    // Multiple visible rows (or split panes) must merge rather than overwrite each other.
    scope: { id: storageKey },
    mutationFn: async (id: string) => {
      const previous = parseSeenEntries(await AsyncStorage.getItem(storageKey));
      const next = rememberSeenEntries(previous, [id]);
      await AsyncStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    },
    onError: () => setSaveFailed(true),
    onSuccess: (ids) => queryClient.setQueryData(["journal-seen", storageKey], ids),
  });
  const { mutate, reset } = save;
  const { refetch } = query;
  const markSeen = useCallback(
    (id: string) => {
      const previous = queryClient.getQueryData<string[]>(["journal-seen", storageKey]);
      if (previous?.includes(id)) return;
      mutate(id);
    },
    [mutate, queryClient, storageKey],
  );
  const retry = useCallback(() => {
    setSaveFailed(false);
    reset();
    void refetch();
  }, [reset, refetch]);
  const seen = useMemo(() => new Set(query.data ?? []), [query.data]);
  return {
    seen,
    ready: query.isSuccess,
    canTrack: query.isSuccess && !saveFailed,
    failed: query.isError || saveFailed,
    retry,
    markSeen,
  };
}
