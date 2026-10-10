import { StyleSheet } from "react-native-unistyles";

export const TASK_CARD_ROW_HEIGHT = 40;
export const TASK_CARD_TOUCH_ROW_HEIGHT = 52;

export const taskCardStyles = StyleSheet.create((theme) => {
  const surface = {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: theme.borderWidth[1],
    borderRadius: theme.borderRadius.lg,
  };
  const contentInsets = {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  };
  return {
    surface,
    contentInsets,
    // Equal outer insets keep header-only and collapsed cards vertically centered.
    scrollContent: contentInsets,
    bodyContent: { gap: theme.spacing[1] },
    fixedHeader: { flexShrink: 0 },
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
    actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 0 },
    headingAction: { borderRadius: theme.borderRadius.full, flexShrink: 0 },
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
      borderRadius: theme.borderRadius.full,
    },
    touchAction: { width: 44, height: 44, minWidth: 44, minHeight: 44 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      height: 32,
      gap: theme.spacing[2],
      flexShrink: 0,
    },
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
