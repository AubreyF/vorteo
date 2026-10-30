import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { useInstallationName } from "@/execution-installation/installation-name";
import { resolveAppVersion } from "@/utils/app-version";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { useVortonUpdate } from "@/vorton-updates/use-update";

/**
 * The same footer closes the main and settings sidebars: which installation this is on
 * the left, its version on the right. The version checks for updates and opens
 * Maintenance, where update status lives.
 */
export function SidebarIdentityFooter({
  onOpenUpdates,
  versionTestID = "sidebar-version",
}: {
  /** Settings selects its own section; elsewhere the footer navigates there. */
  onOpenUpdates?: () => void;
  versionTestID?: string;
}) {
  const name = useInstallationName();
  const { checkNow } = useVortonUpdate();
  const versionText = formatVersionWithPrefix(resolveAppVersion());
  const openUpdates = useCallback(() => {
    if (onOpenUpdates) {
      onOpenUpdates();
      return;
    }
    checkNow();
    router.push(buildSettingsSectionRoute("maintenance"));
  }, [onOpenUpdates, checkNow]);
  return (
    <View style={styles.footer} testID="sidebar-identity-footer">
      <Text style={styles.name} numberOfLines={1} testID="sidebar-installation-name">
        {name}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${versionText}, check for updates`}
        onPress={openUpdates}
        style={styles.versionButton}
        testID={versionTestID}
      >
        <Text style={styles.version} numberOfLines={1}>
          {versionText}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  name: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  versionButton: {
    minHeight: 44,
    justifyContent: "center",
    flexShrink: 0,
  },
  version: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
