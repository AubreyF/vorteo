import React, { useMemo, type ReactNode } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export type StatusBadgeVariant = "success" | "warning" | "error" | "muted";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
  leading?: ReactNode;
  /** `xs` fits beside a line of `sm` text: the same label on tighter padding. */
  size?: "sm" | "xs";
  shape?: "pill" | "row";
}

export function StatusBadge({
  label,
  variant = "muted",
  leading,
  size = "sm",
  shape = "pill",
}: StatusBadgeProps) {
  const pillStyle = useMemo(
    () => [
      styles.pill,
      size === "xs" && styles.pillXs,
      shape === "row" && styles.row,
      variant === "success" && styles.pillSuccess,
      variant === "warning" && styles.pillWarning,
      variant === "error" && styles.pillError,
    ],
    [size, variant, shape],
  );
  const textStyle = useMemo(
    () => [
      styles.pillText,
      shape === "row" && styles.rowText,
      variant === "success" && styles.pillTextSuccess,
      variant === "warning" && styles.pillTextWarning,
      variant === "error" && styles.pillTextError,
    ],
    [variant, shape],
  );

  return (
    <View style={pillStyle}>
      {shape === "row" && leading ? <View style={styles.rowIcon}>{leading}</View> : leading}
      <Text style={textStyle} numberOfLines={shape === "row" ? 1 : undefined}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  pillXs: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
  },
  row: {
    minWidth: 0,
    flexShrink: 1,
    overflow: "hidden",
    height: 24,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 0,
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[1],
  },
  rowText: { minWidth: 0, flexShrink: 1 },
  rowIcon: { flexShrink: 0 },
  pillSuccess: {
    backgroundColor: theme.colors.statusSuccessTint,
    borderColor: "transparent",
  },
  pillWarning: {
    backgroundColor: theme.colors.statusWarningTint,
    borderColor: "transparent",
  },
  pillError: {
    backgroundColor: theme.colors.statusDangerTint,
    borderColor: "transparent",
  },
  pillText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  pillTextSuccess: {
    color: theme.colors.statusSuccess,
  },
  pillTextWarning: {
    color: theme.colors.statusWarning,
  },
  pillTextError: {
    color: theme.colors.statusDanger,
  },
}));
