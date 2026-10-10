import type { AgentJournalEntry } from "@getpaseo/protocol/agent-journal";
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
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useSeenEntries } from "./use-seen-entries";
import { useVisibleEntries } from "./use-visible-entries";
import { JournalRow } from "./row";
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
  if (!supported || !entries?.length) return null;
  return (
    <JournalContent
      key={JSON.stringify([serverId, agentId])}
      serverId={serverId}
      agentId={agentId}
      entries={entries}
    />
  );
}

function JournalContent({
  serverId,
  agentId,
  entries,
}: {
  serverId: string;
  agentId: string;
  entries: AgentJournalEntry[];
}) {
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
    () => mutate({ key: storageKey, sequence: latestJournalSequence(entries) }),
    [mutate, storageKey, entries],
  );
  const clearedThrough = cleared.data ?? 0;
  const visibleEntries = visibleJournalEntries(entries, clearedThrough);
  const count = visibleEntries.length;
  const seenState = useSeenEntries(serverId, agentId);
  const appVisible = useAppActivelyVisible();
  const panelActive = useRetainedPanelActive();
  const activelyViewed = appVisible && panelActive;
  const trackingEnabled = expanded && activelyViewed && seenState.canTrack;
  const unreadEntries = visibleEntries.filter((entry) => !seenState.seen.has(entry.id));
  const unreadCount = unreadEntries.length;
  const { timestamps, viewport } = useVisibleEntries({
    enabled: trackingEnabled && unreadCount > 0,
    entryIds: JSON.stringify(visibleEntries.map((entry) => entry.id)),
    onSeen: seenState.markSeen,
  });
  const hiddenCount = entries.length - count;
  const badge = useMemo(
    () => <JournalCount count={count} unread={unreadCount} ready={seenState.ready} />,
    [count, seenState.ready, unreadCount],
  );
  const notice = useMemo(
    () => <JournalSeenError failed={seenState.failed} onRetry={seenState.retry} />,
    [seenState.failed, seenState.retry],
  );
  return (
    <TaskCard testID="agent-journal-card" bodyVisible={expanded} bodyRef={viewport} notice={notice}>
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title="Journal"
          expanded={expanded}
          onPress={toggle}
          count={badge}
          testID="agent-journal-toggle"
        />
        <JournalViewAction
          count={count}
          disabled={cleared.isPending || cleared.isError || changeView.isPending}
          onClear={clearJournal}
          onShowHistory={showHistory}
        />
      </TaskCardHeader>
      {expanded && count === 0 ? (
        <Text style={styles.empty}>
          Journal cleared on this device. New entries will appear here.
        </Text>
      ) : null}
      {expanded ? (
        <View>
          {visibleEntries.map((entry, index) => (
            <JournalRow
              key={entry.id}
              entry={entry}
              first={index === 0}
              last={index === count - 1}
              ready={seenState.ready}
              seen={seenState.seen.has(entry.id)}
              timestamps={timestamps}
              animate={activelyViewed}
            />
          ))}
        </View>
      ) : null}
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

function JournalSeenError({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const touch = useVortonTouch();
  if (!failed) return null;
  return (
    <View style={styles.readError}>
      <Text style={styles.empty}>Could not save or load seen entries on this device.</Text>
      <Button variant="ghost" size={touch ? "md" : "xs"} onPress={onRetry}>
        Retry
      </Button>
    </View>
  );
}

function JournalViewAction({
  count,
  disabled,
  onClear,
  onShowHistory,
}: {
  count: number;
  disabled: boolean;
  onClear: () => void;
  onShowHistory: () => void;
}) {
  const compact = useIsCompactFormFactor();
  const touch = useVortonTouch();
  const clearLabel = compact ? "Clear" : "Clear journal";
  const historyLabel = compact ? "History" : "Show history";
  return (
    <Button
      variant="ghost"
      size={touch ? "md" : "xs"}
      disabled={disabled}
      accessibilityLabel={count ? "Clear journal" : "Show history"}
      accessibilityHint="Changes this device's view. Journal history is retained."
      testID={count ? "journal-clear" : "journal-show-history"}
      onPress={count ? onClear : onShowHistory}
    >
      {count ? clearLabel : historyLabel}
    </Button>
  );
}

function JournalCount({ count, unread, ready }: { count: number; unread: number; ready: boolean }) {
  return (
    <View style={styles.counts}>
      <CountBadge label={String(count)} accessibilityLabel={`${count} journal entries`} />
      {ready && unread > 0 ? (
        <Text
          style={styles.unreadCount}
          testID="journal-unread-count"
          accessibilityLabel={`${unread} unread journal entries`}
        >
          {unread} new
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  counts: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  unreadCount: { fontSize: theme.fontSize.sm - 2, color: theme.colors.statusDanger },
  readError: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
}));

const HEADING_ICON = <TaskCardIcon kind="journal" />;
