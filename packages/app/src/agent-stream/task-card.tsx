import {
  CardGridContext,
  CardGridInsetContext,
  CardTileContext,
  cardGridCollapsedStyle,
  cardGridExpandedStyle,
} from "./card-grid";
import { TruncatedText } from "@/components/ui/truncated-text";
import {
  CardPaneDividerContext,
  ScrollDividerContext,
  useScrollDivider,
} from "@/components/use-scroll-divider";
import { panelHeaderInset, usePanelSpacing } from "@/styles/use-panel-spacing";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
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
import { ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import { useWindowDimensions } from "@/appearance/interface-geometry";
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
import { TASK_CARD_BODY_INSET, TASK_CARD_BOTTOM_INSET, taskCardStyles } from "./task-card-styles";

function CardSurfaceContext({
  report,
  tile,
  children,
}: {
  report: React.ContextType<typeof ScrollDividerContext>;
  tile: React.ContextType<typeof CardTileContext>;
  children: ReactNode;
}) {
  return (
    <ScrollDividerContext value={report}>
      <CardTileContext value={tile}>{children}</CardTileContext>
    </ScrollDividerContext>
  );
}

function CardBodyBoundary({ children }: { children: ReactNode }) {
  return (
    <CardGridContext value={false}>
      <CardColumnContext value={null}>{children}</CardColumnContext>
    </CardGridContext>
  );
}

function useCardTile(bodyVisible: boolean) {
  const grid = useContext(CardGridContext);
  const [width, setWidth] = useState(Infinity);
  const column = useContext(CardColumnContext);
  const compact = grid && !bodyVisible && !column?.allCollapsed;
  const tile = useMemo(() => ({ compact, width }), [compact, width]);
  const rootStyle = [grid && cardGridExpandedStyle, compact && cardGridCollapsedStyle];
  return { tile, setWidth, rootStyle };
}

/** Every tile reports, so a resize anywhere re-measures the collapsed rows it may have moved. */
function useTileLayout(id: string) {
  const tileLayout = useContext(CardColumnContext)?.onTileLayout;
  return useCallback(
    (event: import("react-native").LayoutChangeEvent) => tileLayout?.(id, event),
    [tileLayout, id],
  );
}

function cardHeight({
  column,
  compact,
  id,
  naturalHeight,
  viewportHeight,
}: {
  column: React.ContextType<typeof CardColumnContext>;
  compact: boolean;
  id: string;
  naturalHeight: number;
  viewportHeight: number;
}) {
  if (compact) return naturalHeight;
  if (column) return column.heights.get(id) ?? naturalHeight;
  return Math.min(naturalHeight, viewportHeight / 2);
}

/** Fit sidebar cards to their shared height budget; embedded cards cap at half the viewport. */
function TaskCardView({
  insets = 0,
  flushBody = false,
  bodyVisible = true,
  bodyRef,
  panelHeight,
  notice,
  children,
  testID,
  style,
}: {
  insets?: number;
  /** List rows own their horizontal alignment with header actions. */
  flushBody?: boolean;
  bodyVisible?: boolean;
  bodyRef?: Ref<ScrollView>;
  /** Panels such as file trees own their scrolling and need a bounded viewport. */
  panelHeight?: number | "fill";
  notice?: ReactNode;
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { tile, setWidth, rootStyle } = useCardTile(bodyVisible);
  const compact = tile.compact;
  const divider = useScrollDivider();
  const { inset: panelInset, onLayout: onPanelLayout } = usePanelSpacing();
  const grid = useContext(CardGridContext);
  const gridInset = useContext(CardGridInsetContext);
  // A tile changing width must not change the height of its header row.
  const spacingInset = grid ? gridInset : panelInset;
  const onLayout = useCallback(
    (event: import("react-native").LayoutChangeEvent) => {
      onPanelLayout(event);
      if (event.nativeEvent.layout.width > 0) setWidth(event.nativeEvent.layout.width);
    },
    [onPanelLayout, setWidth],
  );
  const paneDivider = useMemo(
    () => ({ scrolled: divider.scrolled, inset: spacingInset }),
    [divider.scrolled, spacingInset],
  );
  const column = useContext(CardColumnContext);
  const retainedActive = useRetainedPanelActive();

  const id = useId();
  const [headerHeight, setHeaderHeight] = useState(32);
  const [bodyHeight, setBodyHeight] = useState(0);
  const measure = column?.measure;
  const { height: viewportHeight } = useWindowDimensions();
  const panelDemand = panelHeight === "fill" ? viewportHeight : panelHeight;
  const bodySpace = bodyVisible ? (panelDemand ?? bodyHeight) : 0;
  const naturalHeight = headerHeight + insets + bodySpace;
  useLayoutEffect(() => {
    measure?.(id, retainedActive ? naturalHeight : null, compact, bodyVisible);
  }, [measure, id, naturalHeight, retainedActive, compact, bodyVisible]);
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
  const maxHeight = cardHeight({ column, compact, id, naturalHeight, viewportHeight });
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
  const onGridLayout = useTileLayout(id);
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
    <CardSurfaceContext report={divider.report} tile={tile}>
      <Animated.View
        entering={cardEnter}
        exiting={cardExit}
        style={[animationStyle, rootStyle]}
        onLayout={onGridLayout}
      >
        <View
          ref={divider.ref}
          testID={testID}
          onLayout={onLayout}
          style={[taskCardStyles.surface, style, { minHeight: 0, flex: 1, overflow: "hidden" }]}
        >
          <View style={taskCardStyles.scrollContent}>
            <View
              testID={testID ? `${testID}-header` : undefined}
              style={[
                taskCardStyles.fixedHeader,
                inlineUnistylesStyle({
                  paddingHorizontal: spacingInset,
                  paddingVertical: panelHeaderInset(spacingInset),
                }),
              ]}
              onLayout={onHeaderLayout}
            >
              {header}
              {notice}
              <View
                pointerEvents="none"
                testID={testID ? `${testID}-scroll-divider` : undefined}
                style={[
                  taskCardStyles.headerDivider,
                  {
                    opacity: panelHeight === undefined && bodyVisible && divider.scrolled ? 1 : 0,
                  },
                ]}
              />
            </View>
            {panelHeight !== undefined ? (
              <View
                style={[
                  inlineUnistylesStyle({
                    height: Math.max(0, maxHeight - headerHeight - insets),
                    minHeight: 0,
                    paddingHorizontal: spacingInset,
                    paddingBottom: TASK_CARD_BOTTOM_INSET,
                  }),
                  !bodyVisible && taskCardStyles.hiddenBody,
                ]}
              >
                <CardPaneDividerContext.Provider value={paneDivider}>
                  <CardBodyBoundary>{body}</CardBodyBoundary>
                </CardPaneDividerContext.Provider>
              </View>
            ) : (
              <ScrollView
                ref={bodyRef}
                onContentSizeChange={onBodySize}
                onScroll={divider.onScroll}
                scrollEventThrottle={16}
                testID={testID ? `${testID}-body-scroll` : undefined}
                style={[taskCardStyles.scrollBody, !bodyVisible && taskCardStyles.hiddenBody]}
                contentContainerStyle={[
                  taskCardStyles.bodyContent,
                  flushBody && taskCardStyles.flushBody,
                  inlineUnistylesStyle({
                    paddingHorizontal: (flushBody ? 0 : TASK_CARD_BODY_INSET) + spacingInset,
                    paddingTop: 2,
                    paddingBottom: TASK_CARD_BOTTOM_INSET,
                  }),
                ]}
                nestedScrollEnabled
                scrollEnabled={scrollEnabled}
                keyboardShouldPersistTaps="handled"
              >
                <QueueDragScrollContext.Provider value={setDragging}>
                  <CardBodyBoundary>{body}</CardBodyBoundary>
                </QueueDragScrollContext.Provider>
              </ScrollView>
            )}
          </View>
        </View>
      </Animated.View>
    </CardSurfaceContext>
  );
}

const BoundedTaskCard = withUnistyles(TaskCardView, (theme) => ({
  insets: theme.borderWidth[1] * 2,
}));

type TaskCardProps = ComponentProps<typeof BoundedTaskCard> & {
  /** Question forms scroll with the conversation, without a nested viewport. */
  scrollBody?: boolean;
};

export function TaskCard({ scrollBody = true, ...props }: TaskCardProps) {
  return scrollBody ? <BoundedTaskCard {...props} /> : <ContentTaskCard {...props} />;
}

function ContentTaskCard({
  children,
  testID,
  style,
  flushBody,
  bodyVisible = true,
}: TaskCardProps) {
  const { inset, onLayout } = usePanelSpacing();
  const parts = Children.toArray(children);
  const isHeader = (part: ReactNode) => isValidElement(part) && part.type === TaskCardHeader;
  return (
    <Animated.View entering={cardEnter} exiting={cardExit} style={contentCardStyle}>
      <View testID={testID} onLayout={onLayout} style={[taskCardStyles.surface, style]}>
        <View
          testID={testID ? `${testID}-header` : undefined}
          style={[
            taskCardStyles.fixedHeader,
            inlineUnistylesStyle({
              paddingHorizontal: inset,
              paddingVertical: panelHeaderInset(inset),
            }),
          ]}
        >
          {parts.filter(isHeader)}
        </View>
        <View
          testID={testID ? `${testID}-body` : undefined}
          style={[
            taskCardStyles.bodyContent,
            inlineUnistylesStyle({
              paddingHorizontal: (flushBody ? 0 : TASK_CARD_BODY_INSET) + inset,
              paddingTop: 2,
              paddingBottom: TASK_CARD_BOTTOM_INSET,
            }),
            !bodyVisible && taskCardStyles.hiddenBody,
          ]}
        >
          <CardColumnContext.Provider value={null}>
            {parts.filter((part) => !isHeader(part))}
          </CardColumnContext.Provider>
        </View>
      </View>
    </Animated.View>
  );
}
const contentCardStyle = { flexShrink: 0 } as const;

/** Compact tiles reveal their actions by opening the full-width card. */
export function TaskCardHeader({ children, testID }: { children: ReactNode; testID?: string }) {
  const touch = useVortonTouch();
  const tile = useContext(CardTileContext);
  const stacked = tile.compact && tile.width < 100;
  const parts = Children.toArray(children);
  const staticHeading = parts.some(
    (child) => isValidElement(child) && child.type === TaskCardTitle,
  );
  return (
    <View
      testID={testID}
      style={[
        taskCardStyles.header,
        staticHeading && [taskCardStyles.staticHeader, touch && taskCardStyles.touchStaticHeader],
        touch && taskCardStyles.touchHeader,
        stacked && { height: "auto", minHeight: 44 },
      ]}
    >
      {children}
    </View>
  );
}

export function TaskCardTitle({ children }: { children: string }) {
  return (
    <TruncatedText style={[taskCardStyles.heading, taskCardStyles.title]} numberOfLines={1}>
      {children}
    </TruncatedText>
  );
}

export function TaskCardActions({ children }: { children: ReactNode }) {
  const tile = useContext(CardTileContext);
  if (tile.compact && tile.width < 320) return null;
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
  const tile = useContext(CardTileContext);
  if (tile.compact && tile.width < 320) return null;
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
