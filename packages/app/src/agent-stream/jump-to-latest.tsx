import { useSubagentsForParent } from "@/subagents";
import { useMemo } from "react";
import { ChevronDown } from "lucide-react-native";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { messageQueueKey, readSharedQueue } from "@/message-queue/runtime";
import { floatingControlSurface } from "@/styles/floating-control";
import { Button } from "@/components/ui/button";

export function JumpToLatest({
  serverId,
  agentId,
  onPress,
}: {
  serverId: string;
  agentId: string;
  onPress: () => void;
}) {
  const subagents = useSubagentsForParent({ serverId, parentAgentId: agentId });
  // The history cards own fetching/subscription. This observer only reads their cache.
  const queue = useFetchQuery({
    dataShape: "value",
    queryKey: messageQueueKey(serverId, agentId),
    queryFn: () => readSharedQueue(serverId, agentId),
    enabled: false,
    staleTimeMs: 0,
  });
  return (
    <JumpToLatestButton
      queuedCount={queue.data?.items.length ?? 0}
      subagentCount={subagents.length}
      onPress={onPress}
    />
  );
}

export function JumpToLatestButton({
  queuedCount,
  subagentCount = 0,
  onPress,
}: {
  queuedCount: number;
  subagentCount?: number;
  onPress: () => void;
}) {
  const count = useMemo(
    () =>
      queuedCount > 0 || subagentCount > 0 ? (
        <Text style={styles.count}>
          {[
            queuedCount > 0 ? `Q${queuedCount}` : null,
            subagentCount > 0 ? `A${subagentCount}` : null,
          ]
            .filter(Boolean)
            .join("  ")}
        </Text>
      ) : undefined,
    [queuedCount, subagentCount],
  );
  return (
    <Button
      size="md"
      variant="secondary"
      leftIcon={ChevronDown}
      trailing={count}
      style={[styles.button, styles.pill]}
      textStyle={styles.label}
      onPress={onPress}
      accessibilityLabel="Jump to latest"
      testID="scroll-to-bottom-button"
    >
      Latest
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    ...floatingControlSurface(theme),
  },
  pill: { borderRadius: theme.borderRadius.full, paddingHorizontal: theme.spacing[3] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    paddingLeft: theme.spacing[2],
  },
}));
