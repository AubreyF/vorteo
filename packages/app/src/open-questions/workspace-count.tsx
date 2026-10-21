import { MessageCircleQuestion } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { workspaceOpenQuestionCount } from "./model";

const QuestionIcon = withUnistyles(MessageCircleQuestion);
const iconColor = (theme: Theme) => ({ color: theme.colors.statusWarning });

/** A warm, static marker: it stays until the owner answers, so it never pulses. */
export function WorkspaceOpenQuestionCount({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const pending = usePendingArchiveAgentIds(serverId);
  const count = useSessionStore((state) => {
    const session = state.sessions[serverId];
    if (!session?.serverInfo?.features?.agentQuestions) return 0;
    return workspaceOpenQuestionCount(session.agents.values(), workspaceId, pending);
  });
  if (!count) return null;
  return (
    <View style={styles.badge} testID={`workspace-open-questions-${serverId}-${workspaceId}`}>
      <QuestionIcon size={12} uniProps={iconColor} />
      <Text
        style={styles.text}
        accessibilityLabel={`${count} open ${count === 1 ? "question" : "questions"} for you`}
      >
        {count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusWarningTint,
  },
  text: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
}));
