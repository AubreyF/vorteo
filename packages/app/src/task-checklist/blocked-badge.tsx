import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { blockedTaskReason } from "./blocked-reason";

export function BlockedTaskBadge({ task }: { task: AgentTaskItem }) {
  const reason = blockedTaskReason(task);
  return (
    <Tooltip enabledOnMobile>
      <TooltipTrigger accessibilityRole="button" accessibilityLabel={`Blocked: ${reason}`}>
        <StatusBadge label="Blocked" variant="warning" size="xs" />
      </TooltipTrigger>
      <TooltipContent maxWidth={360}>
        <Text style={styles.reason}>{reason}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  reason: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
