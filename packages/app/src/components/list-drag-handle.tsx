import type { ReactNode, Ref } from "react";
import { View, Pressable, type StyleProp, type ViewStyle } from "react-native";
import { GripVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isNative } from "@/constants/platform";
import { useVortonTouch } from "@/vorton-touch";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import type { Theme } from "@/styles/theme";
import type { DraggableRenderItemInfo } from "./draggable-list";

// A plain web activator lets dnd-kit own Space/arrow keys without a Pressable
// consuming the key event first. Native still uses press-in to acquire the drag.
const DragHandleSurface = isNative ? Pressable : View;
const dragKeyboardScope = { keyboardReorder: "true", vortonRowHandle: "true" };
// Whole rows keep keyboard reordering but must not take the grip's `touch-action: none`, which
// would stop the card from scrolling under a finger.
const rowKeyboardScope = { keyboardReorder: "row" };
/** Matches the sidebar's touch hold before a row lifts, so a swipe still scrolls. */
const NATIVE_ROW_DRAG_DELAY_MS = 180;

export function ListDragHandle<T>({
  info,
  disabled,
  label,
  testID,
  inset = true,
}: {
  info: DraggableRenderItemInfo<T>;
  disabled: boolean;
  label: string;
  testID?: string;
  inset?: boolean;
}) {
  const touch = useVortonTouch();
  const handle = disabled ? undefined : info.dragHandleProps;
  return (
    <DragHandleSurface
      {...handle?.attributes}
      {...handle?.listeners}
      ref={handle?.setActivatorNodeRef as Ref<View> | undefined}
      onPressIn={isNative && !disabled ? info.drag : undefined}
      tabIndex={disabled ? -1 : 0}
      accessibilityRole="button"
      dataSet={dragKeyboardScope}
      accessibilityLabel={label}
      accessibilityHint="Drag to change the order. Use Space and arrow keys with a keyboard."
      aria-disabled={disabled}
      testID={testID}
      style={[
        styles.dragHandle,
        taskCardStyles.rowHandle,
        touch && taskCardStyles.touchRowHandle,
        !inset && styles.noInset,
        info.isActive && styles.dragGrabbing,
        disabled && styles.dragDisabled,
      ]}
    >
      <ThemedGrip size={14} uniProps={mutedIconMapping} />
    </DragHandleSurface>
  );
}

/**
 * Make an entire row the drag activator, so it reorders from anywhere without a grip. Pointer
 * drags start after a short movement and touch drags after a short hold, which leaves taps on
 * the row's own buttons and vertical scrolling untouched.
 */
export function ListDragRow<T>({
  info,
  disabled,
  children,
  style,
  testID,
}: {
  info: DraggableRenderItemInfo<T>;
  disabled: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const hint = disabled
    ? undefined
    : "Drag to change the order. Use Space and arrow keys with a keyboard.";
  if (isNative) {
    return (
      <Pressable
        onLongPress={disabled ? undefined : info.drag}
        delayLongPress={NATIVE_ROW_DRAG_DELAY_MS}
        accessibilityHint={hint}
        testID={testID}
        style={style}
      >
        {children}
      </Pressable>
    );
  }
  const handle = disabled ? undefined : info.dragHandleProps;
  // React Native Web renders `role="button"` as a <button>, and the row contains real buttons.
  // The row keeps dnd-kit's focus and sortable description without becoming a button itself.
  const { role: _role, ...attributes } = handle?.attributes ?? {};
  return (
    <View
      {...attributes}
      {...handle?.listeners}
      ref={handle?.setActivatorNodeRef as Ref<View> | undefined}
      dataSet={disabled ? undefined : rowKeyboardScope}
      accessibilityHint={hint}
      testID={testID}
      style={[styles.row, info.isActive && styles.dragGrabbing, style]}
    >
      {children}
    </View>
  );
}

const ThemedGrip = withUnistyles(GripVertical);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const styles = StyleSheet.create(() => ({
  dragHandle: {
    alignItems: "center",
    justifyContent: "center",
    _web: { cursor: "grab" },
    touchAction: "none",
  },
  noInset: { marginLeft: 0 },
  row: { userSelect: "none" },
  dragGrabbing: { _web: { cursor: "grabbing" } },
  dragDisabled: { opacity: 0.35, _web: { cursor: "auto" } },
}));
