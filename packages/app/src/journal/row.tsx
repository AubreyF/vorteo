import { useCallback, type RefObject } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentJournalEntry } from "@getpaseo/protocol/agent-journal";
import { useVortonTouch } from "@/vorton-touch";
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
  const touch = useVortonTouch();
  const timestamp = new Date(entry.timestamp);
  const register = useCallback(
    (node: View | null) => {
      if (node) timestamps.current.set(entry.id, node);
      else timestamps.current.delete(entry.id);
    },
    [entry.id, timestamps],
  );
  return (
    <View testID={`journal-entry-${entry.id}`} style={[styles.row, touch && styles.touchRow]}>
      {!first ? <View style={[styles.lineAbove, touch && styles.touchLine]} /> : null}
      {!last ? <View style={[styles.lineBelow, touch && styles.touchLine]} /> : null}
      <View style={styles.marker}>
        {ready ? (
          <JournalSpark seen={seen} entryId={entry.id} animate={animate} />
        ) : (
          <View style={styles.markerPlaceholder} />
        )}
      </View>
      <View style={styles.content}>
        <View
          ref={register}
          collapsable={false}
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
        <Text testID="journal-text" selectable style={styles.text}>
          {entry.text}
        </Text>
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  marker: { flexShrink: 0, marginTop: -2 },
  content: { flex: 1, minWidth: 0, gap: 2 },
  markerPlaceholder: { width: 20, height: 20 },
  lineAbove: {
    position: "absolute",
    left: 11.5,
    top: 0,
    height: theme.spacing[1] + 8,
    width: 1,
    backgroundColor: theme.colors.borderAccent,
  },
  lineBelow: {
    position: "absolute",
    left: 11.5,
    top: theme.spacing[1] + 8,
    bottom: 0,
    width: 1,
    backgroundColor: theme.colors.borderAccent,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingLeft: 2,
  },
  touchRow: { paddingLeft: 12 },
  touchLine: { left: 21.5 },
  timestamp: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 16,
  },
  date: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm - 2, lineHeight: 16 },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 2,
    lineHeight: 16,
    fontVariant: ["tabular-nums"],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
  },
}));
