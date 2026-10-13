import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { createContext, useContext } from "react";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export const SidebarInsetContext = createContext(0);

/**
 * Extend through the sidebar's shared inset without moving padded content.
 * Overlay edges preserve header and footer geometry while spacing animates.
 */
export function SidebarSeparator({
  testID,
  edge,
}: { testID?: string; edge?: "top" | "bottom" } = {}) {
  const inset = useContext(SidebarInsetContext);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.line,
        inlineUnistylesStyle(
          edge
            ? { position: "absolute" as const, left: -inset, right: -inset, [edge]: 0 }
            : { marginHorizontal: -inset },
        ),
      ]}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
}));
