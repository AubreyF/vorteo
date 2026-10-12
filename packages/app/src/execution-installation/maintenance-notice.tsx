import { createContext, useContext, useState, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarCallout } from "@/components/sidebar-callout";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

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
}: {
  title: string;
  description: string;
  needsAction: boolean;
  revision: string;
  reviewLabel: string;
  onReview: () => void;
  testID?: string;
}) {
  const placement = useContext(MaintenanceNoticePlacement);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismiss = useCallback(() => setDismissed(revision), [revision]);
  if (needsAction !== (placement === "floating")) return null;
  if (needsAction) {
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
    <View style={styles.row} testID={testID}>
      <Spinner uniProps={spinnerColor} size={16} />
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.description} numberOfLines={1}>
          {description}
        </Text>
      </View>
      <Button variant="ghost" size="sm" onPress={onReview}>
        {reviewLabel}
      </Button>
    </View>
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
    borderTopColor: theme.colors.border,
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foreground },
  description: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foregroundMuted },
}));
