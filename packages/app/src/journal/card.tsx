import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
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
  const count = entries?.length ?? 0;
  const badge = useMemo(
    () => <CountBadge label={String(count)} accessibilityLabel={`${count} journal entries`} />,
    [count],
  );
  if (!supported || !entries?.length) return null;
  return (
    <TaskCard testID="agent-journal-card" bodyVisible={expanded}>
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title="Journal"
          expanded={expanded}
          onPress={toggle}
          count={badge}
          testID="agent-journal-toggle"
        />
      </TaskCardHeader>
      {expanded
        ? entries.map((entry) => {
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
    </TaskCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
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
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
  },
}));

const HEADING_ICON = <TaskCardIcon kind="journal" />;
