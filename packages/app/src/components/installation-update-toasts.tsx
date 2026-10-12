import { SidebarSyncNotice } from "@/sidebar-state/status";
import { useMemo } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { InstallationRestartBanner } from "@/execution-installation/panel";
import { SidebarCalloutViewport } from "@/contexts/sidebar-callout-context";
import { usePathname } from "expo-router";
import { FloatingCalloutPresentation } from "./sidebar-callout";
import { useFloatingNoticeBottomClearance } from "@/contexts/floating-notice-layout";
import { useSettledKeyboardShift } from "@/keyboard/shift";

/** Operational notices belong inside the application, not on its welcome screen. */
export function InstallationUpdateToasts() {
  const pathname = usePathname();
  return pathname === "/welcome" ? null : <OperationalNotices />;
}

function OperationalNotices() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const composerClearance = useFloatingNoticeBottomClearance();
  const keyboardShift = useSettledKeyboardShift();
  const bottom = Math.max(
    width < 640 ? composerClearance + keyboardShift + 8 : 16,
    insets.bottom + 16,
    width < 640 && composerClearance === 0 ? 80 : 0,
  );
  const position = useMemo(
    () => ({
      right: Math.max(16, insets.right),
      bottom,
      width: Math.max(0, Math.min(360, width - insets.left - insets.right - 32)),
      maxHeight: Math.max(0, Math.min(height * 0.45, height - bottom - insets.top - 64)),
    }),
    [width, height, bottom, insets.left, insets.right, insets.top],
  );
  return (
    <View
      style={[styles.viewport, position]}
      pointerEvents="box-none"
      testID="installation-update-toasts"
    >
      <ScrollView
        testID="installation-update-toasts-scroll"
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        <View>
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
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { flexGrow: 0 },
}));
