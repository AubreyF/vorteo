import { useVortonTouch } from "@/vorton-touch";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  useWindowDimensions,
  Platform,
  Modal,
  Pressable,
  StatusBar,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { FloatingSurface } from "@/components/ui/floating";
import { isNative, isWeb } from "@/constants/platform";
import { getOverlayRoot, OVERLAY_Z, useWebOverlayRegistration } from "@/lib/overlay-root";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TooltipContextValue {
  contentId: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<View | null>;
  enabled: boolean;
  openOnPress: boolean;
  touch: boolean;
  delayDuration: number;
}

const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltipContext(componentName: string): TooltipContextValue {
  const ctx = useContext(TooltipContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <Tooltip />`);
  }
  return ctx;
}

// Tooltips should open on hover or keyboard focus, not when focus is restored
// programmatically (e.g. when a Modal closes and returns focus to its opener).
// Track the last input modality on web so TooltipTrigger can ignore focus
// events that weren't keyboard-driven. Native has no equivalent scenario.
let lastInputWasKeyboard = false;
if (isWeb && typeof window !== "undefined") {
  const markKeyboard = () => {
    lastInputWasKeyboard = true;
  };
  const markPointer = () => {
    lastInputWasKeyboard = false;
  };
  window.addEventListener("keydown", markKeyboard, true);
  window.addEventListener("mousedown", markPointer, true);
  window.addEventListener("pointerdown", markPointer, true);
  window.addEventListener("touchstart", markPointer, true);
}

function shouldOpenOnFocus(): boolean {
  return !isWeb || lastInputWasKeyboard;
}

function isCallable(fn: unknown): fn is (...args: unknown[]) => void {
  return typeof fn === "function";
}

function composeEventHandlers(
  original: unknown,
  injected: (event: unknown) => void,
): (event: unknown) => void {
  return (event: unknown) => {
    if (isCallable(original)) {
      original(event);
    }
    injected(event);
  };
}

function useControllableOpenState({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}): [boolean, (next: boolean) => void] {
  const [internalOpen, setInternalOpen] = useState(Boolean(defaultOpen));
  const isControlled = typeof open === "boolean";
  const value = isControlled ? open : internalOpen;
  const setValue = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  return [value, setValue];
}

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

function resolveActualSide(args: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  side: Side;
  offset: number;
}): Side {
  const { triggerRect, contentSize, displayArea, side, offset } = args;
  const spaceTop = triggerRect.y - displayArea.y;
  const spaceBottom = displayArea.y + displayArea.height - (triggerRect.y + triggerRect.height);
  const spaceLeft = triggerRect.x - displayArea.x;
  const spaceRight = displayArea.x + displayArea.width - (triggerRect.x + triggerRect.width);

  const requiredHeight = contentSize.height + offset + 12;
  const requiredWidth = contentSize.width + offset + 12;
  if (side === "bottom" && spaceBottom < requiredHeight && spaceTop > spaceBottom) return "top";
  if (side === "top" && spaceTop < requiredHeight && spaceBottom > spaceTop) return "bottom";
  if (side === "left" && spaceLeft < requiredWidth && spaceRight > spaceLeft) return "right";
  if (side === "right" && spaceRight < requiredWidth && spaceLeft > spaceRight) return "left";
  return side;
}

function resolveAlignedCoordinate(args: {
  align: Align;
  start: number;
  size: number;
  contentSize: number;
}): number {
  const { align, start, size, contentSize } = args;
  if (align === "start") return start;
  if (align === "end") return start + size - contentSize;
  return start + (size - contentSize) / 2;
}

function computePosition({
  triggerRect,
  contentSize,
  displayArea,
  side,
  align,
  offset,
}: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  side: Side;
  align: Align;
  offset: number;
}): { x: number; y: number; actualSide: Side } {
  const { width: contentWidth, height: contentHeight } = contentSize;
  const actualSide = resolveActualSide({ triggerRect, contentSize, displayArea, side, offset });

  let x = 0;
  let y = 0;

  if (actualSide === "bottom") {
    y = triggerRect.y + triggerRect.height + offset;
    x = resolveAlignedCoordinate({
      align,
      start: triggerRect.x,
      size: triggerRect.width,
      contentSize: contentWidth,
    });
  } else if (actualSide === "top") {
    y = triggerRect.y - contentHeight - offset;
    x = resolveAlignedCoordinate({
      align,
      start: triggerRect.x,
      size: triggerRect.width,
      contentSize: contentWidth,
    });
  } else if (actualSide === "left") {
    x = triggerRect.x - contentWidth - offset;
    y = resolveAlignedCoordinate({
      align,
      start: triggerRect.y,
      size: triggerRect.height,
      contentSize: contentHeight,
    });
  } else {
    x = triggerRect.x + triggerRect.width + offset;
    y = resolveAlignedCoordinate({
      align,
      start: triggerRect.y,
      size: triggerRect.height,
      contentSize: contentHeight,
    });
  }

  const padding = 12;
  x = Math.max(padding, Math.min(displayArea.width - contentWidth - padding, x));
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentHeight - padding, y),
  );

  return { x, y, actualSide };
}

export function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  delayDuration = 0,
  enabledOnDesktop = true,
  enabledOnMobile = false,
  children,
}: PropsWithChildren<{
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  enabledOnDesktop?: boolean;
  enabledOnMobile?: boolean;
}>): ReactElement {
  const contentId = useId();
  const triggerRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useControllableOpenState({
    open,
    defaultOpen,
    onOpenChange,
  });

  const isCompact = useIsCompactFormFactor();
  const touch = useVortonTouch();
  const useTouchInteraction = isNative || isCompact || touch;
  const enabled = useTouchInteraction ? enabledOnMobile : enabledOnDesktop;

  useEffect(() => {
    if (!isWeb || !useTouchInteraction || !enabled || !isOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const trigger: unknown = triggerRef.current;
      if (
        trigger instanceof HTMLElement &&
        event.target instanceof Node &&
        trigger.contains(event.target)
      )
        return;
      setIsOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [useTouchInteraction, enabled, isOpen, setIsOpen]);

  const value = useMemo<TooltipContextValue>(
    () => ({
      contentId,
      open: isOpen,
      setOpen: setIsOpen,
      triggerRef,
      enabled,
      openOnPress: useTouchInteraction,
      touch: useTouchInteraction,
      delayDuration,
    }),
    [contentId, isOpen, setIsOpen, enabled, useTouchInteraction, delayDuration],
  );

  return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>;
}

export function TooltipTrigger({
  children,
  disabled,
  onHoverIn,
  onHoverOut,
  onFocus,
  onBlur,
  onPress,
  asChild = false,
  triggerRefProp = "ref",
  ...props
}: PressableProps & {
  "aria-describedby"?: string;
  asChild?: boolean;
  triggerRefProp?: string;
}): ReactElement {
  const ctx = useTooltipContext("TooltipTrigger");
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    if (!ctx.enabled || disabled) return;
    clearOpenTimer();
    if (ctx.delayDuration <= 0) {
      ctx.setOpen(true);
      return;
    }
    openTimerRef.current = setTimeout(() => {
      ctx.setOpen(true);
      openTimerRef.current = null;
    }, ctx.delayDuration);
  }, [clearOpenTimer, ctx, disabled]);

  const close = useCallback(() => {
    clearOpenTimer();
    ctx.setOpen(false);
  }, [clearOpenTimer, ctx]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
    };
  }, [clearOpenTimer]);

  const handleHoverIn = useCallback(
    (e?: unknown) => {
      if (isCallable(onHoverIn)) onHoverIn(e);
      if (!ctx.touch) scheduleOpen();
    },
    [onHoverIn, scheduleOpen, ctx.touch],
  );

  const handleHoverOut = useCallback(
    (e?: unknown) => {
      if (isCallable(onHoverOut)) onHoverOut(e);
      if (!ctx.touch) close();
    },
    [onHoverOut, close, ctx.touch],
  );

  const handleFocus = useCallback(
    (e: unknown) => {
      if (isCallable(onFocus)) onFocus(e);
      if (!ctx.enabled || disabled) return;
      if (!shouldOpenOnFocus()) return;
      clearOpenTimer();
      ctx.setOpen(true);
    },
    [clearOpenTimer, ctx, disabled, onFocus],
  );

  const handleBlur = useCallback(
    (e: unknown) => {
      if (isCallable(onBlur)) onBlur(e);
      close();
    },
    [close, onBlur],
  );

  const handlePress = useCallback(
    (e: unknown) => {
      if (isCallable(onPress)) onPress(e);
      if (!ctx.enabled || disabled) {
        return;
      }
      if (ctx.openOnPress) {
        clearOpenTimer();
        ctx.setOpen(ctx.touch ? !ctx.open : true);
        return;
      }
      close();
    },
    [clearOpenTimer, close, ctx, disabled, onPress],
  );

  const triggerProps = {
    ...props,
    "aria-describedby":
      [props["aria-describedby"], ctx.open && ctx.enabled ? ctx.contentId : undefined]
        .filter(Boolean)
        .join(" ") || undefined,
    disabled,
    onHoverIn: handleHoverIn,
    onHoverOut: handleHoverOut,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onPress: handlePress,
    ...(isWeb
      ? ({
          // RN Web's hover handling can vary across environments; pointer events are the most reliable.
          onPointerEnter: handleHoverIn,
          onPointerLeave: handleHoverOut,
          onMouseEnter: handleHoverIn,
          onMouseLeave: handleHoverOut,
        } as object)
      : null),
  };

  if (asChild) {
    const child = Children.only(children);
    if (!isValidElement(child)) {
      throw new Error("TooltipTrigger with asChild expects a single React element child");
    }

    const rawProps: unknown = child.props;
    if (typeof rawProps !== "object" || rawProps === null) {
      throw new Error("TooltipTrigger asChild child must have props object");
    }
    const mergedProps: Record<string, unknown> = {
      ...Object.assign({}, rawProps),
      ...triggerProps,
      disabled: Reflect.get(rawProps, "disabled") || disabled,
      onHoverIn: composeEventHandlers(Reflect.get(rawProps, "onHoverIn"), handleHoverIn),
      onHoverOut: composeEventHandlers(Reflect.get(rawProps, "onHoverOut"), handleHoverOut),
      onFocus: composeEventHandlers(Reflect.get(rawProps, "onFocus"), handleFocus),
      onBlur: composeEventHandlers(Reflect.get(rawProps, "onBlur"), handleBlur),
      onPress: composeEventHandlers(Reflect.get(rawProps, "onPress"), handlePress),
      onPointerEnter: composeEventHandlers(Reflect.get(rawProps, "onPointerEnter"), handleHoverIn),
      onPointerLeave: composeEventHandlers(Reflect.get(rawProps, "onPointerLeave"), handleHoverOut),
      onMouseEnter: composeEventHandlers(Reflect.get(rawProps, "onMouseEnter"), handleHoverIn),
      onMouseLeave: composeEventHandlers(Reflect.get(rawProps, "onMouseLeave"), handleHoverOut),
    };

    // Preserve descriptions supplied by the control while associating the open tooltip.
    const descriptions = [Reflect.get(rawProps, "aria-describedby"), props["aria-describedby"]];
    if (ctx.open && ctx.enabled) descriptions.push(ctx.contentId);
    mergedProps["aria-describedby"] = descriptions.filter(Boolean).join(" ") || undefined;

    const existingRefProp = Reflect.get(rawProps, triggerRefProp);
    mergedProps[triggerRefProp] = (node: View) => {
      if (isCallable(existingRefProp)) {
        existingRefProp(node);
      } else if (existingRefProp && typeof existingRefProp === "object") {
        Object.assign(existingRefProp, { current: node });
      }
      Object.assign(ctx.triggerRef, { current: node });
    };

    return cloneElement(child, mergedProps);
  }

  return (
    <Pressable {...triggerProps} ref={ctx.triggerRef} collapsable={false}>
      {children}
    </Pressable>
  );
}

export function TooltipContent({
  children,
  side = "top",
  align = "center",
  offset = 12,
  style,
  testID,
  maxWidth = 288,
}: PropsWithChildren<{
  side?: Side;
  align?: Align;
  offset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  maxWidth?: number;
}>): ReactElement | null {
  const ctx = useTooltipContext("TooltipContent");
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const handleOverlayKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      ctx.setOpen(false);
      return true;
    },
    [ctx],
  );
  const setOverlayScope = useWebOverlayRegistration({
    active: isWeb && ctx.open && ctx.enabled,
    layer: OVERLAY_Z.tooltip,
    onKeyDown: handleOverlayKey,
    focusBehavior: "none",
  });
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof computePosition> | null>(null);

  useEffect(() => {
    if (!ctx.open || !ctx.enabled || !ctx.triggerRef.current) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return () => {};
    }

    const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    let cancelled = false;

    void measureElement(ctx.triggerRef.current).then((rect) => {
      if (!cancelled) setTriggerRect({ ...rect, y: rect.y + statusBarHeight });
      return undefined;
    });

    return () => {
      cancelled = true;
    };
  }, [ctx.enabled, ctx.open, ctx.triggerRef, screenWidth, screenHeight]);

  useEffect(() => {
    if (!isWeb || !ctx.open || !ctx.enabled) return;
    const dismissOnScroll = () => ctx.setOpen(false);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => window.removeEventListener("scroll", dismissOnScroll, true);
  }, [ctx]);

  useEffect(() => {
    if (!triggerRect || !contentSize) return;
    const displayArea = { x: 0, y: 0, width: screenWidth, height: screenHeight };
    const result = computePosition({
      triggerRect,
      contentSize,
      displayArea,
      side,
      align,
      offset,
    });
    setPosition(result);
  }, [triggerRect, contentSize, side, align, offset, screenWidth, screenHeight]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize({ width, height });
    },
    [],
  );

  const frameStyle = useMemo(
    () => [
      {
        position: "absolute" as const,
        top: position?.y ?? -9999,
        left: position?.x ?? -9999,
        maxWidth: Math.min(maxWidth, Math.max(0, screenWidth - 24)),
      },
    ],
    [maxWidth, position?.x, position?.y, screenWidth],
  );
  const contentStyle = useMemo(() => [styles.content, style], [style]);

  const arrow =
    position && triggerRect && contentSize ? (
      <View
        testID="tooltip-arrow"
        accessible={false}
        aria-hidden
        style={[
          styles.arrow,
          styles.arrowPlacement(position.actualSide),
          {
            left: resolveArrowCoordinate({
              side: position.actualSide,
              axis: "x",
              trigger: triggerRect.x + triggerRect.width / 2 - position.x,
              size: contentSize.width,
            }),
            top: resolveArrowCoordinate({
              side: position.actualSide,
              axis: "y",
              trigger: triggerRect.y + triggerRect.height / 2 - position.y,
              size: contentSize.height,
            }),
          },
        ]}
      />
    ) : null;

  const handleDismiss = useCallback(() => ctx.setOpen(false), [ctx]);

  if (!ctx.open || !ctx.enabled) return null;

  // On web, avoid React Native's <Modal/> implementation (it uses <dialog> and can
  // steal focus / disrupt hover). Rendering via Portal + position:fixed keeps the
  // exact same positioning math as DropdownMenu, without hover feedback loops.
  if (isWeb) {
    return createPortal(
      <View pointerEvents="none" style={styles.portalOverlay}>
        <FloatingSurface
          pointerEvents="none"
          ref={setOverlayScope}
          entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(180).reduceMotion(ReduceMotion.System)}
          collapsable={false}
          role="tooltip"
          nativeID={ctx.contentId}
          testID={testID}
          onLayout={handleLayout}
          style={contentStyle}
          frameStyle={frameStyle}
        >
          {arrow}
          {children}
        </FloatingSurface>
      </View>,
      getOverlayRoot(),
    );
  }

  return (
    <Modal
      visible={ctx.open}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={handleDismiss}
    >
      <Pressable testID="tooltip-dismiss" style={styles.overlay} onPress={handleDismiss}>
        <FloatingSurface
          pointerEvents="none"
          entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(180).reduceMotion(ReduceMotion.System)}
          collapsable={false}
          role="tooltip"
          nativeID={ctx.contentId}
          testID={testID}
          onLayout={handleLayout}
          style={contentStyle}
          frameStyle={frameStyle}
        >
          {arrow}
          {children}
        </FloatingSurface>
      </Pressable>
    </Modal>
  );
}

function resolveArrowCoordinate({
  side,
  axis,
  trigger,
  size,
}: {
  side: Side;
  axis: "x" | "y";
  trigger: number;
  size: number;
}): number {
  if (axis === "x" && side === "right") return -5;
  if (axis === "x" && side === "left") return size - 5;
  if (axis === "y" && side === "bottom") return -5;
  if (axis === "y" && side === "top") return size - 5;
  return Math.min(Math.max(18, trigger), Math.max(18, size - 18)) - 5;
}

/** Shared label and explanatory copy for non-interactive tooltips. */
export function TooltipText({ label, description }: { label: string; description?: ReactNode }) {
  return (
    <View style={styles.textBody}>
      <Text style={styles.label}>{label}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  arrow: {
    position: "absolute",
    width: 10,
    height: 10,
    backgroundColor: theme.colors.popover,
    borderColor: theme.colors.borderAccent,
    transform: [{ rotate: "45deg" }],
  },
  arrowPlacement: (side: Side) => ({
    borderTopWidth: side === "bottom" || side === "left" ? 1 : 0,
    borderRightWidth: side === "top" || side === "left" ? 1 : 0,
    borderBottomWidth: side === "top" || side === "right" ? 1 : 0,
    borderLeftWidth: side === "bottom" || side === "right" ? 1 : 0,
  }),
  textBody: { alignItems: "center", gap: 4 },
  label: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base * (13 / 14),
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    textAlign: "center",
  },
  overlay: { flex: 1 },
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: OVERLAY_Z.tooltip,
  },
  content: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    ...theme.shadow.md,
    zIndex: 1000,
  },
}));
