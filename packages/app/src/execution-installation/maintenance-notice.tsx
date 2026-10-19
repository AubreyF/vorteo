import { createContext, useContext, useState, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarCallout } from "@/components/sidebar-callout";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";

export const MaintenanceNoticePlacement = createContext<"floating" | "sidebar" | "rail">(
  "floating",
);
const Spinner = withUnistyles(LoadingSpinner);
const spinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Dismissal hides this notice only. Request decisions remain in Installation controls. */
export function MaintenanceNotice({
  title,
  description,
  needsAction,
  revision,
  reviewLabel,
  onReview,
  testID,
  sidebarOnly = false,
}: {
  title: string;
  description: string;
  needsAction: boolean;
  revision: string;
  reviewLabel: string;
  onReview: () => void;
  testID?: string;
  sidebarOnly?: boolean;
}) {
  const placement = useContext(MaintenanceNoticePlacement);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismiss = useCallback(() => setDismissed(revision), [revision]);
  // Recovery stays with the sidebar status rows, including pending owner decisions.
  if (sidebarOnly ? placement === "floating" : needsAction !== (placement === "floating"))
    return null;
  if (needsAction && !sidebarOnly) {
    if (dismissed === revision) return null;
    return (
      <SidebarCallout
        title={title}
        description={description}
        testID={testID}
        onDismiss={dismiss}
        actions={[
          { label: reviewLabel, onPress: onReview },
          { label: "Dismiss", onPress: dismiss },
        ]}
      />
    );
  }
  if (placement === "rail") {
    return (
      <Pressable
        accessibilityRole="button"
        style={styles.railButton}
        onPress={onReview}
        accessibilityLabel={`${title}. ${reviewLabel}`}
        testID={testID}
      >
        <Spinner uniProps={spinnerColor} size={16} />
      </Pressable>
    );
  }
  return (
    <Pressable
      style={styles.row}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${reviewLabel}`}
      accessibilityHint={description}
      onPress={onReview}
    >
      <SidebarSeparator edge="top" testID={testID ? `${testID}-divider` : undefined} />
      <Spinner uniProps={spinnerColor} size={16} />
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.description} numberOfLines={1}>
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  railButton: {
    width: 44,
    height: 44,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "transparent",
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foreground },
  description: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foregroundMuted },
}));
