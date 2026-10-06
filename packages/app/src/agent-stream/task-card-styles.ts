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
  return {
    surface,
    container: {
      ...surface,
      paddingVertical: { xs: theme.spacing[2], md: theme.spacing[4] },
      paddingLeft: { xs: theme.spacing[3], md: theme.spacing[4] },
      paddingRight: theme.spacing[2],
      gap: theme.spacing[2],
    },
    item: {
      minHeight: TASK_CARD_ROW_HEIGHT,
      paddingVertical: theme.spacing[1],
      gap: theme.spacing[1],
      justifyContent: "center",
    },
    separator: { borderTopWidth: theme.borderWidth[1], borderTopColor: theme.colors.border },
    rowText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
    actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 0 },
    actionInset: { paddingRight: theme.spacing[1] },
    iconAction: {
      width: 32,
      height: 32,
      minHeight: 32,
      paddingHorizontal: 0,
      paddingVertical: 0,
      borderRadius: theme.borderRadius.full,
    },
    touchAction: { minWidth: 44, minHeight: 44 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: TASK_CARD_ROW_HEIGHT,
      gap: theme.spacing[2],
    },
    touchHeader: { minHeight: TASK_CARD_TOUCH_ROW_HEIGHT },
    accordionTrigger: {
      flex: 1,
      minWidth: 0,
      minHeight: TASK_CARD_ROW_HEIGHT,
      justifyContent: "flex-start",
      paddingHorizontal: theme.spacing[2],
    },
    heading: {
      lineHeight: Math.max(16, Math.round(theme.fontSize.sm * 1.4)),
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
    },
  };
});
