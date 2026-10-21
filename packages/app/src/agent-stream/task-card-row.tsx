import type { ComponentProps, ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useVortonTouch } from "@/vorton-touch";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import {
  LIST_ROW_ACTION_SIZE,
  LIST_ROW_ICON_TEXT_GAP,
  LIST_ROW_TOUCH_ACTION_SIZE,
} from "@/styles/list-row-metrics";
import {
  TASK_CARD_ICON_CENTER,
  TASK_CARD_ROW_HEIGHT,
  TASK_CARD_TOUCH_ROW_HEIGHT,
} from "./task-card-styles";

/** Space between row children; the icon slot adds the rest of the sidebar's icon-to-text gap. */
const ROW_GAP = 4;
/** Leading glyph slot, centered on the heading icon so row icons and heading icons share a rail. */
const ICON_SLOT_WIDTH = 20;
/** Touch slots are wider so a leading control stays easy to hit without moving the text far. */
const TOUCH_ICON_SLOT_WIDTH = 32;

/** Shared list rhythm for task, queue and subagent rows inside a card. */
export function TaskCardRow({ style, ...props }: ViewProps) {
  const touch = useVortonTouch();
  return <View {...props} style={[styles.row, touch && styles.touch, style]} />;
}

/** Keep a drag handle and its adjacent status or attachment together. */
export function TaskCardRowLeading(props: ViewProps) {
  const touch = useVortonTouch();
  return <View {...props} style={[styles.leading, touch && styles.leadingTouch, props.style]} />;
}

/**
 * The leading status or icon column. It sits on the heading's icon centerline and keeps the same
 * gap to the row text as a sidebar status circle keeps to its workspace name.
 */
export function TaskCardRowIcon(props: ViewProps) {
  const touch = useVortonTouch();
  return <View {...props} style={[styles.icon, touch && styles.iconTouch, props.style]} />;
}

/** Trailing icon buttons sized like the sidebar's row actions. */
export function useTaskCardRowActionStyle() {
  const touch = useVortonTouch();
  return touch ? styles.touchAction : styles.action;
}

interface TaskCardRowActionProps extends Omit<
  ComponentProps<typeof Button>,
  "variant" | "size" | "style"
> {
  /** Shown on hover; the accessibility label names the action. */
  tooltip?: ReactNode;
}

/** An icon-only row action with an optional hover explanation. */
export function TaskCardRowAction({ tooltip, ...props }: TaskCardRowActionProps) {
  const style = useTaskCardRowActionStyle();
  const button = <Button {...props} variant="ghost" size="sm" style={style} />;
  if (!tooltip || !props.accessibilityLabel) return button;
  return (
    <Tooltip enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" offset={8}>
        <TooltipText label={props.accessibilityLabel} description={tooltip} />
      </TooltipContent>
    </Tooltip>
  );
}

const actionBox = (size: number) => ({
  width: size,
  height: size,
  minWidth: size,
  minHeight: size,
  paddingHorizontal: 0,
  paddingVertical: 0,
  flexShrink: 0,
  alignItems: "center" as const,
  justifyContent: "center" as const,
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: TASK_CARD_ROW_HEIGHT,
    gap: ROW_GAP,
    // Center trailing row actions under the heading's icon-only actions.
    paddingRight: TASK_CARD_ICON_CENTER - LIST_ROW_ACTION_SIZE / 2,
  },
  leading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 0 },
  leadingTouch: { gap: 0 },
  touch: {
    minHeight: TASK_CARD_TOUCH_ROW_HEIGHT,
    paddingRight: Math.max(0, TASK_CARD_ICON_CENTER - LIST_ROW_TOUCH_ACTION_SIZE / 2),
  },
  icon: {
    width: ICON_SLOT_WIDTH,
    marginLeft: TASK_CARD_ICON_CENTER - ICON_SLOT_WIDTH / 2,
    marginRight: LIST_ROW_ICON_TEXT_GAP - ROW_GAP,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  iconTouch: {
    width: TOUCH_ICON_SLOT_WIDTH,
    marginLeft: TASK_CARD_ICON_CENTER - TOUCH_ICON_SLOT_WIDTH / 2,
    marginRight: 0,
  },
  action: { ...actionBox(LIST_ROW_ACTION_SIZE), borderRadius: theme.borderRadius.md },
  touchAction: { ...actionBox(LIST_ROW_TOUCH_ACTION_SIZE), borderRadius: theme.borderRadius.lg },
}));
