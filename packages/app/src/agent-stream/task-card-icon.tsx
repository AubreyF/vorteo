import {
  FileText,
  BookOpen,
  MessageCircleQuestion,
  MessagesSquare,
  ShieldCheck,
  Target,
  Users,
} from "lucide-react-native";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

import type { Theme } from "@/styles/theme";

const palette = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const icons = {
  journal: withUnistyles(BookOpen),
  messages: withUnistyles(MessagesSquare),
  goal: withUnistyles(Target),
  subagents: withUnistyles(Users),
  plan: withUnistyles(FileText),
  question: withUnistyles(MessageCircleQuestion),
  permission: withUnistyles(ShieldCheck),
};

/** Decorative heading marks share the task progress chart's footprint. */
export function TaskCardIcon({ kind }: { kind: keyof typeof icons }) {
  const Icon = icons[kind];
  return (
    <View
      style={styles.frame}
      testID={`task-card-icon-${kind}`}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon size={18} uniProps={palette} />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  frame: { width: 20, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" },
}));
