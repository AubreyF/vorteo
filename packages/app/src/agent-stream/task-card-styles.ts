import { StyleSheet } from "react-native-unistyles";
import { FLOATING_PANEL_RADIUS, FLOATING_PANEL_CONTROL_HEIGHT } from "@/styles/floating-panel";
import {
  LIST_ROW_HEIGHT,
  LIST_ROW_SPACING,
  LIST_ROW_TOUCH_HEIGHT,
} from "@/styles/list-row-metrics";

// Shared leading centerline for heading icons, row handles and journal markers.
export const TASK_CARD_ICON_CENTER = FLOATING_PANEL_CONTROL_HEIGHT / 2;
export const TASK_CARD_TOUCH_ICON_CENTER = TASK_CARD_ICON_CENTER;

export const TASK_CARD_BODY_INSET = 12;
export const TASK_CARD_BOTTOM_INSET = 8;
// Card rows share the sidebar's row rhythm so both columns keep one density.
export const TASK_CARD_ROW_HEIGHT = LIST_ROW_HEIGHT;
export const TASK_CARD_TOUCH_ROW_HEIGHT = LIST_ROW_TOUCH_HEIGHT;

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
      paddingHorizontal: TASK_CARD_BODY_INSET,
      paddingVertical: theme.spacing[1],
      gap: LIST_ROW_SPACING,
    },
    // Secondary drag targets stay tall while reserving less horizontal space on touch.
    rowHandle: { width: 24, marginLeft: TASK_CARD_ICON_CENTER - 12, minHeight: 32 },
    touchRowHandle: { width: 32, marginLeft: TASK_CARD_ICON_CENTER - 16, minHeight: 44 },
    flushBody: { paddingHorizontal: 0 },
    // Restore prose clearance inside flush list bodies without shifting their controls.
    proseInset: { paddingHorizontal: TASK_CARD_BODY_INSET },
    proseEndInset: { paddingRight: TASK_CARD_BODY_INSET },
    fixedHeader: { flexShrink: 0 },
    headerDivider: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: theme.borderWidth[1],
      backgroundColor: theme.colors.divider,
    },
    scrollBody: { minHeight: 0, flexShrink: 1, flexGrow: 0 },
    hiddenBody: { display: "none" },
    item: {
      minHeight: TASK_CARD_ROW_HEIGHT,
      paddingVertical: 0,
      gap: theme.spacing[1],
      justifyContent: "center",
    },
    separator: { borderTopWidth: theme.borderWidth[1], borderTopColor: theme.colors.divider },
    rowText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
    actions: { flexDirection: "row", alignItems: "center", gap: 0, flexShrink: 0 },
    headingAction: {
      borderRadius: FLOATING_PANEL_RADIUS,
      height: FLOATING_PANEL_CONTROL_HEIGHT,
      minHeight: FLOATING_PANEL_CONTROL_HEIGHT,
      paddingVertical: 0,
      flexShrink: 0,
    },
    headingInfoText: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      maxWidth: 280,
      lineHeight: theme.fontSize.base * 1.4,
    },
    headingActionText: { fontSize: theme.fontSize.sm },
    actionInset: { paddingRight: theme.spacing[1] },
    iconAction: {
      width: FLOATING_PANEL_CONTROL_HEIGHT,
      height: FLOATING_PANEL_CONTROL_HEIGHT,
      minHeight: FLOATING_PANEL_CONTROL_HEIGHT,
      paddingHorizontal: 0,
      paddingVertical: 0,
      borderRadius: FLOATING_PANEL_RADIUS,
    },
    touchAction: { width: 44, height: 44, minWidth: 44, minHeight: 44 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      height: FLOATING_PANEL_CONTROL_HEIGHT,
      gap: 0,
      flexShrink: 0,
    },
    staticHeader: { paddingHorizontal: TASK_CARD_ICON_CENTER - 10, gap: theme.spacing[2] },
    touchStaticHeader: { paddingHorizontal: 12 },
    touchHeader: { height: 44 },
    touchAccordionTrigger: { height: 44 },
    accordionTrigger: {
      // The enclosing disclosure owns horizontal flex; this button has a fixed height.
      flexShrink: 0,
      minWidth: 0,
      height: FLOATING_PANEL_CONTROL_HEIGHT,
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
