import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ReviewTaskBadge({ task }: { task: AgentTaskItem }) {
  const reason = task.description?.trim() || "Waiting for review.";
  return (
    <Tooltip enabledOnMobile>
      <TooltipTrigger
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={`Review: ${reason}`}
      >
        <StatusBadge label="Review" size="xs" />
      </TooltipTrigger>
      <TooltipContent maxWidth={360}>
        <Text style={styles.reason}>{reason}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: { alignItems: "center", justifyContent: "center" },
  reason: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
