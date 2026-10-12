import { StyleSheet } from "react-native-unistyles";

export const FLOATING_PANEL_INSET = 8;
export const FLOATING_PANEL_RADIUS = 16;

/** Shared chrome for both navigation and the complete supporting-card group. */
export const floatingPanelStyles = StyleSheet.create((theme) => ({
  surface: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: FLOATING_PANEL_RADIUS,
    backgroundColor: theme.colors.surfaceSidebar,
    ...theme.shadow.md,
  },
}));
