import { useCallback, type RefObject } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentJournalEntry } from "@getpaseo/protocol/agent-journal";
import { JournalSpark } from "./spark";

interface JournalRowProps {
  entry: AgentJournalEntry;
  first: boolean;
  last: boolean;
  ready: boolean;
  seen: boolean;
  animate: boolean;
  timestamps: RefObject<Map<string, View>>;
}

export function JournalRow({
  entry,
  first,
  last,
  ready,
  seen,
  animate,
  timestamps,
}: JournalRowProps) {
  const timestamp = new Date(entry.timestamp);
  const register = useCallback(
    (node: View | null) => {
      if (node) timestamps.current.set(entry.id, node);
      else timestamps.current.delete(entry.id);
    },
    [entry.id, timestamps],
  );
  return (
    <View testID={`journal-entry-${entry.id}`} style={styles.row}>
      {!first ? <View style={styles.lineAbove} /> : null}
      {!last ? <View style={styles.lineBelow} /> : null}
      <View ref={register} collapsable={false} style={styles.timestampGroup}>
        {ready ? (
          <JournalSpark seen={seen} entryId={entry.id} animate={animate} />
        ) : (
          <View style={styles.markerPlaceholder} />
        )}
        <View
          testID="journal-timestamp"
          style={styles.timestamp}
          accessibilityLabel={timestamp.toLocaleString()}
        >
          <Text style={styles.date}>
            {timestamp.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </Text>
          <Text style={styles.time}>
            {timestamp.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      </View>
      <Text testID="journal-text" selectable style={styles.text}>
        {entry.text}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  timestampGroup: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  markerPlaceholder: { width: 20, height: 20 },
  lineAbove: {
    position: "absolute",
    left: theme.spacing[2] + 9.5,
    top: 0,
    height: theme.spacing[2] + 10,
    width: 1,
    backgroundColor: theme.colors.borderAccent,
  },
  lineBelow: {
    position: "absolute",
    left: theme.spacing[2] + 9.5,
    top: theme.spacing[2] + 10,
    bottom: 0,
    width: 1,
    backgroundColor: theme.colors.borderAccent,
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
