import { useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { resizeColumn, type ColumnWidths } from "./geometry";

interface ColumnResizeHandleProps {
  column: keyof ColumnWidths;
  widths: ColumnWidths;
  containerWidth: number;
  onPreview: (column: keyof ColumnWidths, width: number) => void;
  onCommit: (column: keyof ColumnWidths, width: number) => void;
}

export function ColumnResizeHandle({
  column,
  widths,
  containerWidth,
  onPreview,
  onCommit,
}: ColumnResizeHandleProps) {
  const initial = useRef({ widths, pointerX: 0 });
  const [pressed, setPressed] = useState(false);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onBegin((event) => {
          initial.current = { widths, pointerX: event.absoluteX };
          setPressed(true);
        })
        .onUpdate((event) => {
          const next = resizeColumn({
            column,
            initial: initial.current.widths,
            translation: event.absoluteX - initial.current.pointerX,
            containerWidth,
          });
          onPreview(column, next[column]);
        })
        .onEnd((event) => {
          const next = resizeColumn({
            column,
            initial: initial.current.widths,
            translation: event.absoluteX - initial.current.pointerX,
            containerWidth,
          });
          onCommit(column, next[column]);
        })
        .onFinalize(() => setPressed(false)),
    [column, widths, containerWidth, onPreview, onCommit],
  );
  return (
    <View pointerEvents="box-none" style={absoluteFill}>
      <SidebarResizeHandle
        edge={column === "cards" ? "left" : "right"}
        gesture={gesture}
        pressed={pressed}
        testID={`thread-${column}-resize`}
      />
    </View>
  );
}
const absoluteFill = { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 } as const;
