import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import {
  journalViewKey,
  latestJournalSequence,
  parseClearedThrough,
  visibleJournalEntries,
} from "./view-state";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { useVortonTouch } from "@/vorton-touch";
import { CountBadge } from "@/components/ui/count-badge";

export function JournalCard({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { supported, entries } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agentDetails.get(agentId) ?? session?.agents.get(agentId);
      return {
        supported: session?.serverInfo?.features?.agentJournal === true,
        entries: agent?.journal,
      };
    }),
  );
  const [expanded, setExpanded] = useState(true);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const touch = useVortonTouch();
  const buttonSize = touch ? "md" : "xs";
  const storageKey = journalViewKey(serverId, agentId);
  const queryKey = ["journal-view", storageKey];
  const queryClient = useQueryClient();
  const toast = useToast();
  const cleared = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey,
    queryFn: async () => parseClearedThrough(await AsyncStorage.getItem(storageKey)),
  });
  const changeView = useMutation({
    mutationFn: async (view: { key: string; sequence: number }) => {
      await AsyncStorage.setItem(view.key, String(view.sequence));
      return view;
    },
    onSuccess: (view) => queryClient.setQueryData(["journal-view", view.key], view.sequence),
    onError: () => toast.error("Could not save the journal view. Please try again."),
  });
  const { mutate } = changeView;
  const showHistory = useCallback(
    () => mutate({ key: storageKey, sequence: 0 }),
    [mutate, storageKey],
  );
  const clearJournal = useCallback(
    () => mutate({ key: storageKey, sequence: latestJournalSequence(entries ?? []) }),
    [mutate, storageKey, entries],
  );
  const clearedThrough = cleared.data ?? 0;
  const visibleEntries = visibleJournalEntries(entries ?? [], clearedThrough);
  const count = visibleEntries.length;
  const hiddenCount = (entries?.length ?? 0) - count;
  const badge = useMemo(
    () => <CountBadge label={String(count)} accessibilityLabel={`${count} journal entries`} />,
    [count],
  );
  if (!supported || !entries?.length) return null;
  return (
    <TaskCard testID="agent-journal-card" bodyVisible={expanded}>
      <TaskCardHeader>
        <TaskCardIcon kind="journal" />
        <CardDisclosure
          title="Journal"
          expanded={expanded}
          onPress={toggle}
          count={badge}
          testID="agent-journal-toggle"
        />
        <Button
          variant="ghost"
          size={buttonSize}
          disabled={cleared.isPending || cleared.isError || changeView.isPending}
          accessibilityHint="Changes this device's view. Journal history is retained."
          testID={count ? "journal-clear" : "journal-show-history"}
          onPress={count ? clearJournal : showHistory}
        >
          {count ? "Clear journal" : "Show history"}
        </Button>
      </TaskCardHeader>
      {expanded && count === 0 ? (
        <Text style={styles.empty}>
          Journal cleared on this device. New entries will appear here.
        </Text>
      ) : null}
      {expanded
        ? visibleEntries.map((entry) => {
            const timestamp = new Date(entry.timestamp);
            return (
              <View key={entry.id} testID={`journal-entry-${entry.id}`} style={styles.row}>
                <View style={styles.timestamp} accessibilityLabel={timestamp.toLocaleString()}>
                  <Text style={styles.date}>
                    {timestamp.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </Text>
                  <Text style={styles.time}>
                    {timestamp.toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                </View>
                <Text selectable style={styles.text}>
                  {entry.text}
                </Text>
              </View>
            );
          })
        : null}
      {expanded && hiddenCount > 0 && count > 0 ? (
        <Button
          variant="ghost"
          size={buttonSize}
          disabled={changeView.isPending}
          testID="journal-show-history"
          onPress={showHistory}
        >
          Show history ({hiddenCount})
        </Button>
      ) : null}
    </TaskCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
  },
  timestamp: { width: 64, flexShrink: 0, gap: theme.spacing[1] },
  date: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm - 2 },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 2,
    fontVariant: ["tabular-nums"],
  },
  text: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    // Compensate for the prose line leading without tightening paragraph spacing.
    marginTop: -Math.round(theme.fontSize.sm / 6),
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
  },
}));
