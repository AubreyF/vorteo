import { useMemo, type ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const displayDataSet = { pdisplay: true };

interface ScreenTitleProps {
  children: ReactNode;
  numberOfLines?: number;
  testID?: string;
  style?: StyleProp<TextStyle>;
}

/**
 * Canonical screen title for use inside `ScreenHeader`. One typography, one
 * color, responsive weight. Leading icons are siblings (HeaderToggleButton,
 * HeaderIconBadge) — never nested inside this component.
 */
export function ScreenTitle({ children, numberOfLines = 1, testID, style }: ScreenTitleProps) {
  const combinedStyle = useMemo(() => [styles.text, style], [style]);
  return (
    <Text
      style={combinedStyle}
      dataSet={displayDataSet}
      numberOfLines={numberOfLines}
      testID={testID}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xl,
    fontFamily: theme.fontFamily.display,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
}));
