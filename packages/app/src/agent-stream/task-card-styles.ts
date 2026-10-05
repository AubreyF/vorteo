import { StyleSheet } from "react-native-unistyles";

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
      minHeight: 40,
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
      alignItems: "flex-start",
      minHeight: 24,
      gap: theme.spacing[2],
    },
    touchHeader: { minHeight: 30 },
    // Let the icon hit area extend into padding while its glyph aligns with the visible heading text.
    headerAction: { marginTop: -5 },
    touchHeaderAction: { marginTop: -11 },
    heading: {
      alignSelf: "flex-start",
      lineHeight: Math.max(16, Math.round(theme.fontSize.sm * 1.4)),
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
    },
  };
});
