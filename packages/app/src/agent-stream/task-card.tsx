import { useCallback, useContext, type ReactNode } from "react";
import { ScrollView, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { QueueDragScrollContext, useQueueDragScroll } from "@/message-queue/drag-scroll";
import { taskCardStyles } from "./task-card-styles";

/** Bound the entire card, including its header, as the viewport resizes. */
export function TaskCard({
  children,
  testID,
  style,
  contentContainerStyle,
}: {
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}) {
  const { height } = useWindowDimensions();
  const parentDrag = useContext(QueueDragScrollContext);
  const { scrollEnabled, onDragActive } = useQueueDragScroll(true);
  const setDragging = useCallback(
    (active: boolean) => {
      onDragActive(active);
      parentDrag(active);
    },
    [onDragActive, parentDrag],
  );
  return (
    <ScrollView
      testID={testID}
      style={[taskCardStyles.surface, style, { maxHeight: height / 2, flexGrow: 0 }]}
      contentContainerStyle={[taskCardStyles.scrollContent, contentContainerStyle]}
      nestedScrollEnabled
      scrollEnabled={scrollEnabled}
      keyboardShouldPersistTaps="handled"
    >
      <QueueDragScrollContext.Provider value={setDragging}>
        {children}
      </QueueDragScrollContext.Provider>
    </ScrollView>
  );
}
