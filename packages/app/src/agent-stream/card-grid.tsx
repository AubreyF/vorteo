import { createContext, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { CARD_GAP } from "./columns/geometry";
import { usePanelSpacing } from "@/styles/use-panel-spacing";

export const CardGridContext = createContext(false);
export const CardGridInsetContext = createContext(2);
export const CardTileContext = createContext({ compact: false, width: Infinity });

/** Flex lines preserve card identity while expanded cards break adjacent collapsed runs. */
export function CardGrid({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { inset, onLayout } = usePanelSpacing();
  return (
    <CardGridContext value={true}>
      <CardGridInsetContext value={inset}>
        <View style={[gridStyle, style]} testID={testID} onLayout={onLayout}>
          {children}
        </View>
      </CardGridInsetContext>
    </CardGridContext>
  );
}

const gridStyle = {
  flexDirection: "row",
  flexWrap: "wrap",
  alignContent: "flex-start",
  alignItems: "flex-start",
  rowGap: CARD_GAP,
  columnGap: 4,
  width: "100%",
  minWidth: 0,
} as const;

// Layout-transparent groups keep their mounted children in the surrounding grid.
export const cardGridGroupStyle = { display: "contents" } as const;
export const cardGridExpandedStyle = { width: "100%", minWidth: 0, flexShrink: 0 } as const;
export const cardGridCollapsedStyle = { flexBasis: 0, flexGrow: 1, minWidth: 44 } as const;
