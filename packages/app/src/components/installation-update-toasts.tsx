import { SidebarSyncNotice } from "@/sidebar-state/status";
import { useCallback, useMemo, useState } from "react";
import {
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { InstallationRestartBanner } from "@/execution-installation/panel";
import { SidebarCalloutViewport } from "@/contexts/sidebar-callout-context";
import { usePathname } from "expo-router";
import { Button } from "@/components/ui/button";
import { FloatingCalloutPresentation } from "./sidebar-callout";

/** One app-wide host keeps tracked maintenance visible across routes and sidebar states. */
export function InstallationUpdateToasts() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const compactWelcome = width < 640 && pathname === "/welcome";
  const [expanded, setExpanded] = useState(false);
  const [hasNotices, setHasNotices] = useState(false);
  const collapsed = compactWelcome && !expanded;
  const disclosureState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const measureNotices = useCallback((event: LayoutChangeEvent) => {
    setHasNotices(event.nativeEvent.layout.height > 0);
  }, []);
  const position = useMemo(
    () => ({
      right: Math.max(16, insets.right),
      bottom: Math.max(width < 640 ? 80 : 16, insets.bottom + 16),
      width: Math.max(0, Math.min(360, width - insets.left - insets.right - 32)),
      maxHeight: Math.max(0, height * 0.45 - insets.top - insets.bottom),
    }),
    [width, height, insets.left, insets.right, insets.top, insets.bottom],
  );
  return (
    <View
      style={[styles.viewport, position]}
      pointerEvents="box-none"
      testID="installation-update-toasts"
    >
      {compactWelcome && hasNotices ? (
        <Button
          testID="installation-update-toasts-toggle"
          accessibilityState={disclosureState}
          aria-expanded={!collapsed}
          onPress={toggleExpanded}
        >
          {collapsed ? "Updates and maintenance" : "Collapse updates"}
        </Button>
      ) : null}
      <ScrollView
        testID="installation-update-toasts-scroll"
        style={[styles.scroll, collapsed && styles.collapsed]}
        aria-hidden={collapsed}
        importantForAccessibility={collapsed ? "no-hide-descendants" : "auto"}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        <View onLayout={measureNotices}>
          <FloatingCalloutPresentation>
            <SidebarSyncNotice />
            <InstallationRestartBanner />
            <SidebarCalloutViewport />
          </FloatingCalloutPresentation>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  // Portal sheets must cover these persistent controls while a dialog is open.
  viewport: { position: "absolute", zIndex: 0 },
  collapsed: {
    maxHeight: 0,
    overflow: "hidden",
    // Keep the measured content mounted, but exclude its web controls from focus.
    ...Platform.select({ web: { visibility: "hidden" as const } }),
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { flexGrow: 0 },
}));
