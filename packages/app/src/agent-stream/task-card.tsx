import { useVortonTouch } from "@/vorton-touch";
import {
  Children,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
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
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  withTiming,
  ReduceMotion,
} from "react-native-reanimated";
import { withUnistyles } from "react-native-unistyles";
import { CardColumnContext } from "./columns/card-column";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react-native";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipText } from "@/components/ui/tooltip";
import { taskCardStyles } from "./task-card-styles";

/** Bound the entire card, including its header, as the viewport resizes. */
function TaskCardView({
  insets = 0,
  bodyVisible = true,
  bodyRef,
  panelHeight,
  notice,
  children,
  testID,
  style,
}: {
  insets?: number;
  bodyVisible?: boolean;
  bodyRef?: Ref<ScrollView>;
  /** Panels such as file trees own their scrolling and need a bounded viewport. */
  panelHeight?: number;
  notice?: ReactNode;
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const column = useContext(CardColumnContext);
  const retainedActive = useRetainedPanelActive();
  const id = useId();
  const [headerHeight, setHeaderHeight] = useState(32);
  const [bodyHeight, setBodyHeight] = useState(0);
  const measure = column?.measure;
  const bodySpace = bodyVisible ? (panelHeight ?? bodyHeight) : 0;
  const naturalHeight = headerHeight + insets + bodySpace;
  useLayoutEffect(() => {
    measure?.(id, retainedActive ? naturalHeight : null);
  }, [measure, id, naturalHeight, retainedActive]);
  useLayoutEffect(() => () => measure?.(id, null), [measure, id]);
  const onHeaderLayout = useCallback((event: import("react-native").LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setHeaderHeight(height);
  }, []);
  const onBodySize = useCallback((width: number, measuredHeight: number) => {
    // Hidden retained cards can report an empty layout. Keep the last real
    // demand so returning to a workspace does not animate from a collapsed card.
    if (width > 0) setBodyHeight(measuredHeight);
  }, []);
  const parts = Children.toArray(children);
  const isHeader = (part: ReactNode) => isValidElement(part) && part.type === TaskCardHeader;
  const header = parts.find(isHeader);
  const body = parts.filter((part) => !isHeader(part));
  const { height } = useWindowDimensions();
  const maxHeight = column
    ? (column.heights.get(id) ?? naturalHeight)
    : Math.min(naturalHeight, height / 2);
  // Animate only height. Positional layout transitions treat a retained hidden
  // card's zero DOM rect as its origin and fly it across the page on reactivation.
  const animationStyle = useAnimatedStyle(
    () => ({
      height: withTiming(maxHeight, {
        duration: 220,
        easing,
        reduceMotion: ReduceMotion.System,
      }),
      flexShrink: 0,
      overflow: "hidden" as const,
    }),
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
    <Animated.View entering={cardEnter} exiting={cardExit} style={animationStyle}>
      <View
        testID={testID}
        style={[taskCardStyles.surface, style, { minHeight: 0, flex: 1, overflow: "hidden" }]}
      >
        <View style={taskCardStyles.scrollContent}>
          <View
            testID={testID ? `${testID}-header` : undefined}
            style={taskCardStyles.fixedHeader}
            onLayout={onHeaderLayout}
          >
            {header}
            {notice}
          </View>
          {panelHeight !== undefined ? (
            <View
              style={[
                {
                  height: Math.max(0, maxHeight - headerHeight - insets),
                  minHeight: 0,
                },
                !bodyVisible && taskCardStyles.hiddenBody,
              ]}
            >
              <CardColumnContext.Provider value={null}>{body}</CardColumnContext.Provider>
            </View>
          ) : (
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
          )}
        </View>
      </View>
    </Animated.View>
  );
}

export const TaskCard = withUnistyles(TaskCardView, (theme) => ({
  insets: theme.borderWidth[1] * 2,
}));

/** Explicit heading slot, rendered outside the card's body scroll region. */
export function TaskCardHeader({ children, testID }: { children: ReactNode; testID?: string }) {
  const touch = useVortonTouch();
  return (
    <View
      testID={testID}
      style={[
        taskCardStyles.header,
        Children.toArray(children).some(
          (child) => isValidElement(child) && child.type === TaskCardTitle,
        ) && taskCardStyles.staticHeader,
        touch && taskCardStyles.touchHeader,
      ]}
    >
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
  tooltipDescription?: ReactNode;
}

/** Heading actions share one visual contract; callers supply behavior and content only. */
export function TaskCardAction({
  iconOnly = false,
  tooltipDescription,
  ...props
}: TaskCardActionProps) {
  const touch = useVortonTouch();
  const button = (
    <Button
      {...props}
      variant="ghost"
      size={touch ? "md" : "sm"}
      style={[
        taskCardStyles.headingAction,
        iconOnly && taskCardStyles.iconAction,
        iconOnly && touch && taskCardStyles.touchAction,
      ]}
      textStyle={taskCardStyles.headingActionText}
    />
  );
  if (!iconOnly || !props.accessibilityLabel) return button;
  return (
    <Tooltip enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" offset={8}>
        <TooltipText
          label={props.accessibilityLabel}
          description={tooltipDescription ?? props.accessibilityHint}
        />
      </TooltipContent>
    </Tooltip>
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
    <TaskCardAction
      iconOnly
      leftIcon={Info}
      accessibilityLabel={label}
      testID={testID}
      tooltipDescription={children}
    />
  );
}

// Ease-out exponential approximation supported by both native and web layout transitions.
const easing = Easing.bezier(0.16, 1, 0.3, 1);
const cardEnter = FadeIn.duration(180).easing(easing).reduceMotion(ReduceMotion.System);
const cardExit = FadeOut.duration(160).easing(easing).reduceMotion(ReduceMotion.System);
