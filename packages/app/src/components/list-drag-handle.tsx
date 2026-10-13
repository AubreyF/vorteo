import type { Ref } from "react";
import { View, Pressable } from "react-native";
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
  dragGrabbing: { _web: { cursor: "grabbing" } },
  dragDisabled: { opacity: 0.35, _web: { cursor: "auto" } },
}));
