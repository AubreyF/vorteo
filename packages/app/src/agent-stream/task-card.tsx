import { useVortonTouch } from "@/vorton-touch";
import {
  Children,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type ComponentProps,
  type Ref,
} from "react";
import {
  ScrollView,
  View,
  Text,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { QueueDragScrollContext, useQueueDragScroll } from "@/message-queue/drag-scroll";
import Animated, {
  Easing,
  FadeInUp,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";
import { withUnistyles } from "react-native-unistyles";
import { CardColumnContext } from "./columns/card-column";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react-native";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { taskCardStyles } from "./task-card-styles";

/** Bound the entire card, including its header, as the viewport resizes. */
function TaskCardView({
  insets = 0,
  bodyGap = 0,
  bodyVisible = true,
  bodyRef,
  notice,
  children,
  testID,
  style,
}: {
  insets?: number;
  bodyGap?: number;
  bodyVisible?: boolean;
  bodyRef?: Ref<ScrollView>;
  notice?: ReactNode;
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const column = useContext(CardColumnContext);
  const id = useId();
  const [headerHeight, setHeaderHeight] = useState(32);
  const [bodyHeight, setBodyHeight] = useState(0);
  const measure = column?.measure;
  const bodySpace = bodyVisible ? bodyHeight + bodyGap : 0;
  const naturalHeight = headerHeight + insets + bodySpace;
  useLayoutEffect(() => {
    measure?.(id, naturalHeight);
  }, [measure, id, naturalHeight]);
  useLayoutEffect(() => () => measure?.(id, null), [measure, id]);
  const onHeaderLayout = useCallback((event: import("react-native").LayoutChangeEvent) => {
    setHeaderHeight(event.nativeEvent.layout.height);
  }, []);
  const onBodySize = useCallback((_width: number, measuredHeight: number) => {
    setBodyHeight(measuredHeight);
  }, []);
  const parts = Children.toArray(children);
  const isHeader = (part: ReactNode) => isValidElement(part) && part.type === TaskCardHeader;
  const header = parts.find(isHeader);
  const body = parts.filter((part) => !isHeader(part));
  const { height } = useWindowDimensions();
  const maxHeight = column ? (column.heights.get(id) ?? naturalHeight) : height / 2;
  const animationStyle = useMemo(
    () => ({ maxHeight, flexShrink: 0, overflow: "hidden" as const }),
    [maxHeight],
  );
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
    <Animated.View
      layout={cardTransition}
      entering={cardEnter}
      exiting={cardExit}
      style={animationStyle}
    >
      <View
        testID={testID}
        style={[taskCardStyles.surface, style, { minHeight: 0, flexShrink: 1, overflow: "hidden" }]}
      >
        <View style={[taskCardStyles.scrollContent, { minHeight: 0, flexShrink: 1 }]}>
          <View
            testID={testID ? `${testID}-header` : undefined}
            style={taskCardStyles.fixedHeader}
            onLayout={onHeaderLayout}
          >
            {header}
            {notice}
          </View>
          <ScrollView
            ref={bodyRef}
            onContentSizeChange={onBodySize}
            testID={testID ? `${testID}-body-scroll` : undefined}
            style={[taskCardStyles.scrollBody, !bodyVisible && taskCardStyles.hiddenBody]}
            contentContainerStyle={taskCardStyles.bodyContent}
            nestedScrollEnabled
            scrollEnabled={scrollEnabled}
            keyboardShouldPersistTaps="handled"
          >
            <QueueDragScrollContext.Provider value={setDragging}>
              <CardColumnContext.Provider value={null}>{body}</CardColumnContext.Provider>
            </QueueDragScrollContext.Provider>
          </ScrollView>
        </View>
      </View>
    </Animated.View>
  );
}

export const TaskCard = withUnistyles(TaskCardView, (theme) => ({
  insets: theme.spacing[3] * 2 + theme.borderWidth[1] * 2,
  bodyGap: theme.spacing[3],
}));

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

interface TaskCardActionProps extends Omit<
  ComponentProps<typeof Button>,
  "variant" | "size" | "style" | "textStyle"
> {
  iconOnly?: boolean;
}

/** Heading actions share one visual contract; callers supply behavior and content only. */
export function TaskCardAction({ iconOnly = false, ...props }: TaskCardActionProps) {
  const touch = useVortonTouch();
  return (
    <Button
      {...props}
      variant="outline"
      size={touch ? "md" : "sm"}
      style={[
        taskCardStyles.headingAction,
        iconOnly && taskCardStyles.iconAction,
        iconOnly && touch && taskCardStyles.touchAction,
      ]}
      textStyle={taskCardStyles.headingActionText}
    />
  );
}

export function TaskCardInfo({
  label,
  testID,
  children,
}: {
  label: string;
  testID?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <TaskCardAction iconOnly leftIcon={Info} accessibilityLabel={label} testID={testID} />
      </TooltipTrigger>
      <TooltipContent side="top" align="start" offset={8}>
        <Text style={taskCardStyles.headingInfoText}>{children}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

// Ease-out exponential approximation supported by both native and web layout transitions.
const easing = Easing.bezier(0.16, 1, 0.3, 1);
const cardTransition = LinearTransition.duration(220)
  .easing(easing)
  .reduceMotion(ReduceMotion.System);
const cardEnter = FadeInUp.duration(220).easing(easing).reduceMotion(ReduceMotion.System);
const cardExit = FadeOutUp.duration(160).easing(easing).reduceMotion(ReduceMotion.System);
