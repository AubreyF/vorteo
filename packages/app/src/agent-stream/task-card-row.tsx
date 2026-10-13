import { View, type ViewProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useVortonTouch } from "@/vorton-touch";
import {
  TASK_CARD_ICON_CENTER,
  TASK_CARD_ROW_HEIGHT,
  TASK_CARD_TOUCH_ROW_HEIGHT,
} from "./task-card-styles";

/** Shared list rhythm for task, queue and subagent rows inside a card. */
export function TaskCardRow({ style, ...props }: ViewProps) {
  const touch = useVortonTouch();
  return <View {...props} style={[styles.row, touch && styles.touch, style]} />;
}

/** Keep small glyphs and their status overlays on the heading's leading centerline. */
export function TaskCardRowIcon(props: ViewProps) {
  return <View {...props} style={[styles.icon, props.style]} />;
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: TASK_CARD_ROW_HEIGHT,
    gap: theme.spacing[1],
  },
  touch: { minHeight: TASK_CARD_TOUCH_ROW_HEIGHT },
  icon: {
    width: TASK_CARD_ICON_CENTER * 2,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
}));
