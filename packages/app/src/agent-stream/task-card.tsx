import { Children, isValidElement, useCallback, useContext, type ReactNode } from "react";
import {
  ScrollView,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { QueueDragScrollContext, useQueueDragScroll } from "@/message-queue/drag-scroll";
import { taskCardStyles } from "./task-card-styles";

/** Bound the entire card, including its header, as the viewport resizes. */
export function TaskCard({
  bodyVisible = true,
  children,
  testID,
  style,
  contentContainerStyle,
}: {
  bodyVisible?: boolean;
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}) {
  const parts = Children.toArray(children);
  const isHeader = (part: ReactNode) => isValidElement(part) && part.type === TaskCardHeader;
  const header = parts.find(isHeader);
  const body = parts.filter((part) => !isHeader(part));
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
    <View
      testID={testID}
      style={[
        taskCardStyles.surface,
        style,
        { maxHeight: height / 2, flexShrink: 0, overflow: "hidden" },
      ]}
    >
      <View
        style={[
          taskCardStyles.scrollContent,
          contentContainerStyle,
          { minHeight: 0, flexShrink: 1 },
        ]}
      >
        <View testID={testID ? `${testID}-header` : undefined} style={taskCardStyles.fixedHeader}>
          {header}
        </View>
        <ScrollView
          testID={testID ? `${testID}-body-scroll` : undefined}
          style={[taskCardStyles.scrollBody, !bodyVisible && taskCardStyles.hiddenBody]}
          contentContainerStyle={taskCardStyles.bodyContent}
          nestedScrollEnabled
          scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled"
        >
          <QueueDragScrollContext.Provider value={setDragging}>
            {body}
          </QueueDragScrollContext.Provider>
        </ScrollView>
      </View>
    </View>
  );
}

/** Explicit heading slot, rendered outside the card's body scroll region. */
export function TaskCardHeader({ children }: { children: ReactNode }) {
  return children;
}
