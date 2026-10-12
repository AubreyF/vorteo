import { StyleSheet } from "react-native-unistyles";
import { FLOATING_PANEL_RADIUS } from "@/styles/floating-panel";

export const TASK_CARD_ROW_HEIGHT = 40;
export const TASK_CARD_TOUCH_ROW_HEIGHT = 52;

export const taskCardStyles = StyleSheet.create((theme) => {
  const surface = {
    backgroundColor: theme.colors.surfaceSidebar,
    borderColor: theme.colors.border,
    borderWidth: theme.borderWidth[1],
    borderRadius: FLOATING_PANEL_RADIUS,
  };
  return {
    surface,
    // TaskCard adds the shared width-adaptive inset around headers and body content.
    scrollContent: { minHeight: 0, flexShrink: 1 },
    bodyContent: {
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1],
      gap: theme.spacing[1],
    },
    flushBody: { paddingHorizontal: 0 },
    fixedHeader: { flexShrink: 0 },
    headerDivider: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: theme.borderWidth[1],
      backgroundColor: theme.colors.border,
    },
    scrollBody: { minHeight: 0, flexShrink: 1, flexGrow: 0 },
    hiddenBody: { display: "none" },
    item: {
      minHeight: TASK_CARD_ROW_HEIGHT,
      paddingVertical: theme.spacing[1],
      gap: theme.spacing[1],
      justifyContent: "center",
    },
    separator: { borderTopWidth: theme.borderWidth[1], borderTopColor: theme.colors.border },
    rowText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
    actions: { flexDirection: "row", alignItems: "center", gap: 0, flexShrink: 0 },
    headingAction: { borderRadius: FLOATING_PANEL_RADIUS, flexShrink: 0 },
    headingInfoText: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      maxWidth: 280,
      lineHeight: theme.fontSize.base * 1.4,
    },
    headingActionText: { fontSize: theme.fontSize.sm },
    actionInset: { paddingRight: theme.spacing[1] },
    iconAction: {
      width: 32,
      height: 32,
      minHeight: 32,
      paddingHorizontal: 0,
      paddingVertical: 0,
      borderRadius: FLOATING_PANEL_RADIUS,
    },
    touchAction: { width: 44, height: 44, minWidth: 44, minHeight: 44 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      height: 32,
      gap: 0,
      flexShrink: 0,
    },
    staticHeader: { paddingHorizontal: 6, gap: theme.spacing[2] },
    touchStaticHeader: { paddingHorizontal: 12 },
    touchHeader: { height: 44 },
    touchAccordionTrigger: { height: 44 },
    accordionTrigger: {
      flex: 1,
      minWidth: 0,
      height: 32,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    title: { flex: 1, minWidth: 0 },
    heading: {
      lineHeight: Math.max(16, Math.round(theme.fontSize.sm * 1.4)),
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
    },
  };
});
