import React, { createContext, useContext, type PropsWithChildren } from "react";
import { View, type ViewProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** Shared bottom actions for cards and dialogs. Ordinary actions stay on the right. */
export const FixedActionFooterContext = createContext(false);

export function ActionFooter({ children, style, ...props }: ViewProps) {
  const fixed = useContext(FixedActionFooterContext);
  return (
    <View {...props} style={[style, styles.footer, fixed && styles.fixed]}>
      {children}
    </View>
  );
}

/** Keep destructive actions separated from the save/close group, including when wrapping. */
export function ActionFooterLeading({ children }: PropsWithChildren) {
  return <View style={styles.leading}>{children}</View>;
}

/** Keep related actions together when a leading delete action forces another row. */
export function ActionFooterTrailing({ children }: PropsWithChildren) {
  return <View style={styles.trailing}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  fixed: { paddingTop: 0, flexShrink: 0 },
  footer: {
    alignSelf: "stretch",
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  trailing: {
    marginLeft: "auto",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  leading: {
    marginRight: "auto",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
