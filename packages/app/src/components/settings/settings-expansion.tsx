import { createContext, useContext, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const ExpansionDepth = createContext(0);

/** In-place details belong to their parent, rather than becoming sibling sections. */
export function SettingsExpansion({ children, testID }: { children: ReactNode; testID?: string }) {
  const depth = useContext(ExpansionDepth);
  return (
    <ExpansionDepth.Provider value={depth + 1}>
      <View testID={testID} style={[styles.region, depth > 0 && styles.nested]}>
        {children}
      </View>
    </ExpansionDepth.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  region: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[4],
  },
  nested: { backgroundColor: theme.colors.surface3 },
}));
