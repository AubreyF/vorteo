import { useVortonTouch } from "@/vorton-touch";
import { Children, isValidElement, useCallback, useContext, type ReactNode, type Ref } from "react";
import {
  ScrollView,
  View,
  Text,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { QueueDragScrollContext, useQueueDragScroll } from "@/message-queue/drag-scroll";
import { taskCardStyles } from "./task-card-styles";

/** Bound the entire card, including its header, as the viewport resizes. */
export function TaskCard({
  bodyVisible = true,
  bodyRef,
  notice,
  children,
  testID,
  style,
}: {
  bodyVisible?: boolean;
  bodyRef?: Ref<ScrollView>;
  notice?: ReactNode;
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
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
      <View style={[taskCardStyles.scrollContent, { minHeight: 0, flexShrink: 1 }]}>
        <View testID={testID ? `${testID}-header` : undefined} style={taskCardStyles.fixedHeader}>
          {header}
          {notice}
        </View>
        <ScrollView
          ref={bodyRef}
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
export function TaskCardHeader({ children, testID }: { children: ReactNode; testID?: string }) {
  const touch = useVortonTouch();
  return (
    <View testID={testID} style={[taskCardStyles.header, touch && taskCardStyles.touchHeader]}>
      {children}
    </View>
  );
}

export function TaskCardTitle({ children }: { children: string }) {
  return (
    <Text style={[taskCardStyles.heading, taskCardStyles.title]} numberOfLines={1}>
      {children}
    </Text>
  );
}

export function TaskCardActions({ children }: { children: ReactNode }) {
  return <View style={taskCardStyles.actions}>{children}</View>;
}
