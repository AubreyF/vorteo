import { createContext, useCallback, useId, useMemo, useReducer, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { isNative } from "@/constants/platform";
import { CardColumn } from "./card-column";
import { persistAppSettings, useSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import { ColumnResizeHandle } from "./resize-handle";
import {
  COLUMN_BREAKPOINT,
  COLUMN_FADE_HEIGHT,
  COLUMN_GAP,
  COLUMN_MARGIN,
  resolveColumnWidths,
  resolveTextOffset,
  type ColumnWidths,
} from "./geometry";

export const StreamColumnWidthContext = createContext<number | undefined>(undefined);

interface ColumnLayoutState {
  containerWidth: number;
  draft: Partial<ColumnWidths>;
  saveError: boolean;
}
type ColumnLayoutAction =
  | { type: "measure"; width: number; height: number }
  | { type: "preview" | "saved"; column: keyof ColumnWidths; width: number }
  | { type: "saveFailed" };
const initialLayout: ColumnLayoutState = { containerWidth: 0, draft: {}, saveError: false };
function columnLayoutReducer(
  state: ColumnLayoutState,
  action: ColumnLayoutAction,
): ColumnLayoutState {
  switch (action.type) {
    case "measure":
      // Retained panes report zero while hidden. Keep their last visible layout.
      if (action.width <= 0 || action.height <= 0 || action.width === state.containerWidth)
        return state;
      return { ...state, containerWidth: action.width };
    case "preview":
      return {
        ...state,
        saveError: false,
        draft: { ...state.draft, [action.column]: action.width },
      };
    case "saved":
      if (state.draft[action.column] !== action.width) return state;
      return { ...state, draft: { ...state.draft, [action.column]: undefined } };
    case "saveFailed":
      return { ...state, saveError: true };
  }
}

export function useStreamColumns(
  cards: { showTaskCards?: boolean; trailingCards?: ReactNode },
  defaultTextWidth: number,
) {
  const enabled = !!cards.showTaskCards || !!cards.trailingCards;
  const savedText = useSettings((settings) => settings.threadTextWidth);
  const savedCards = useSettings((settings) => settings.threadCardsWidth);
  const [{ containerWidth, draft, saveError }, dispatch] = useReducer(
    columnLayoutReducer,
    initialLayout,
  );
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    dispatch({ type: "measure", ...event.nativeEvent.layout });
  }, []);
  const widths = useMemo(
    () =>
      resolveColumnWidths(containerWidth, {
        text: draft.text ?? savedText ?? defaultTextWidth,
        cards: draft.cards ?? savedCards,
      }),
    [containerWidth, defaultTextWidth, draft, savedCards, savedText],
  );
  const onPreview = useCallback((column: keyof ColumnWidths, width: number) => {
    dispatch({ type: "preview", column, width });
  }, []);
  const onCommit = useCallback((column: keyof ColumnWidths, width: number) => {
    const updates = column === "text" ? { threadTextWidth: width } : { threadCardsWidth: width };
    dispatch({ type: "preview", column, width });
    void persistAppSettings(updates)
      .then(() => dispatch({ type: "saved", column, width }))
      .catch(() => dispatch({ type: "saveFailed" }));
  }, []);
  const split = enabled && containerWidth >= COLUMN_BREAKPOINT;
  return {
    split,
    saveError,
    contentMaxWidth: split ? widths.text : defaultTextWidth,
    containerWidth,
    widths,
    onLayout,
    onPreview,
    onCommit,
  };
}

export function StreamColumns({
  layout,
  outline,
  children,
}: {
  layout: ReturnType<typeof useStreamColumns>;
  outline: ReactNode;
  children: [ReactNode, ReactNode];
}) {
  const { split, widths, onLayout } = layout;
  const textOffset = resolveTextOffset(layout.containerWidth, widths);
  const textStyle = useMemo(
    () => [
      styles.text,
      split && inlineUnistylesStyle({ width: widths.text, marginLeft: textOffset }),
    ],
    [split, widths.text, textOffset],
  );
  const cardsStyle = useMemo(
    () => [styles.cards, inlineUnistylesStyle({ width: widths.cards })],
    [widths.cards],
  );
  const columnWidth = split ? widths.text : undefined;
  return (
    <View
      style={[styles.root, split && styles.split]}
      onLayout={onLayout}
      testID="thread-content-region"
    >
      {layout.saveError ? (
        <Text accessibilityRole="alert" style={styles.saveError}>
          Could not save column widths. Drag a handle to retry.
        </Text>
      ) : null}
      <View style={[styles.left, split && styles.leftSplit]} testID="thread-text-region">
        <View style={textStyle} testID="thread-text-column">
          <StreamColumnWidthContext.Provider value={columnWidth}>
            {children[0]}
          </StreamColumnWidthContext.Provider>
          {split ? <ColumnResizeHandle column="text" {...layout} /> : null}
        </View>
        {outline}
        {split && isNative ? <ColumnFade /> : null}
      </View>
      {split ? (
        <View style={cardsStyle} testID="thread-cards-column">
          <CardColumn>{children[1]}</CardColumn>
          <ColumnResizeHandle column="cards" {...layout} />
        </View>
      ) : null}
    </View>
  );
}

function FadeSvg({ color }: { color: string }) {
  const id = `column-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={id} x1="0%" y1="0%" x2="0%" y2="100%">
          <Stop offset="0%" stopColor={color} stopOpacity={0} />
          <Stop offset="100%" stopColor={color} stopOpacity={1} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}
const ThemedFadeSvg = withUnistyles(FadeSvg);
const fadeColor = (theme: Theme) => ({ color: theme.colors.surface0 });
function ColumnFade() {
  return (
    <View style={styles.fade} pointerEvents="none" testID="thread-column-fade">
      <ThemedFadeSvg uniProps={fadeColor} />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  saveError: {
    position: "absolute",
    top: 0,
    left: COLUMN_MARGIN,
    zIndex: 20,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
  },
  root: { flex: 1, minHeight: 0, flexDirection: "row", backgroundColor: theme.colors.surface0 },
  split: { paddingRight: COLUMN_MARGIN, gap: COLUMN_GAP },
  left: { flex: 1, minWidth: 0, alignItems: "center" },
  leftSplit: { alignItems: "flex-start" },
  text: { flex: 1, width: "100%", minHeight: 0 },
  cards: { flexShrink: 0, minHeight: 0, paddingVertical: COLUMN_MARGIN },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: COLUMN_FADE_HEIGHT },
}));
