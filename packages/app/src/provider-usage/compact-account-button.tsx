import { type ComponentProps } from "react";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useVortonTouch } from "@/vorton-touch";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";

export function CompactAccountButton({
  style,
  textStyle,
  testID,
  tone = "default",
  dense = false,
  ...props
}: ComponentProps<typeof Button> & {
  tone?: "default" | "danger";
  dense?: boolean;
}) {
  const touch = useVortonTouch();
  return (
    <Button
      {...props}
      testID={testID}
      variant="outline"
      size="xs"
      style={[
        styles.target,
        dense && !touch && styles.denseTarget,
        tone === "danger" && styles.dangerOutline,
        style,
      ]}
      textStyle={[tone === "danger" && styles.dangerText, textStyle]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  dangerText: { color: theme.colors.destructive },
  dangerOutline: { borderColor: theme.colors.destructive },
  // Paint the border on the control itself so touch sizing cannot separate it from its label.
  target: {
    height: CONTROL_HEIGHTS.field,
    minHeight: CONTROL_HEIGHTS.field,
    minWidth: CONTROL_HEIGHTS.field,
    borderWidth: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
    gap: theme.spacing[2],
  },
  denseTarget: {
    height: CONTROL_HEIGHTS.tight,
    minHeight: CONTROL_HEIGHTS.tight,
    borderRadius: theme.borderRadius.md,
    paddingVertical: 0,
  },
}));
