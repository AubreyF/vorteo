import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudOff } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import { useSidebarSyncStatus } from "./use-sidebar-sync";

const OfflineIcon = withUnistyles(CloudOff);
const Spinner = withUnistyles(LoadingSpinner);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function SidebarSyncNotice({ compact = false }: { compact?: boolean }) {
  const status = useSidebarSyncStatus((state) => state.status);
  const error = useSidebarSyncStatus((state) => state.error);
  const queries = useQueryClient();
  const retry = useCallback(() => {
    void queries.invalidateQueries({ queryKey: ["sidebar-state"] });
  }, [queries]);
  if (status !== "pending" && status !== "syncing") return null;
  const syncing = status === "syncing";
  const disconnected = error === "Sidebar host is disconnected";
  let title = "Sidebar sync paused";
  let description = "Tap to retry sidebar sync.";
  if (disconnected) {
    title = "Host unavailable";
    description = "Sidebar sync paused. Tap to retry.";
  } else if (syncing) {
    title = "Syncing sidebar…";
    description = "Saving your sidebar changes.";
  } else if (error) {
    description = `${error}. Tap to retry.`;
  }
  const testID = syncing ? "sidebar-sync-pending" : "sidebar-sync-error";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pressable
          style={compact ? styles.rail : styles.row}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${description}`}
          disabled={syncing}
          onPress={retry}
          testID={testID}
        >
          <SidebarSeparator edge="top" />
          {syncing ? (
            <Spinner size={16} uniProps={iconColor} />
          ) : (
            <OfflineIcon size={18} uniProps={iconColor} />
          )}
          {!compact && (
            <View style={styles.copy}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.description} numberOfLines={2}>
                {description}
              </Text>
            </View>
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="right">
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
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
    minHeight: 48,
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foreground },
  description: { fontSize: theme.fontSize.sm, lineHeight: 16, color: theme.colors.foregroundMuted },
}));
