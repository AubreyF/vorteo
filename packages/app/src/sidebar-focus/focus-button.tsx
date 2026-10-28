import { useCallback } from "react";
import {
  Pressable,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronsRight } from "lucide-react-native";
import { useSidebarActionSize } from "@/components/sidebar/use-sidebar-action-size";
import type { Theme } from "@/styles/theme";

const ThemedChevronsRight = withUnistyles(ChevronsRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function renderIcon({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return (
    <ThemedChevronsRight
      size={14}
      uniProps={hovered || pressed ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

/** Shows only this row's item in the sidebar. Sits immediately left of the row's ⋮ menu. */
export function SidebarFocusButton({
  name,
  onPress,
  testID,
}: {
  name: string;
  onPress: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const actionSize = useSidebarActionSize();
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      actionSize,
      (Boolean(hovered) || pressed) && styles.buttonHovered,
    ],
    [actionSize],
  );
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("sidebar.focus.focusItem", { name })}
      hitSlop={4}
      onPress={handlePress}
      style={style}
      testID={testID}
    >
      {renderIcon}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  buttonHovered: { backgroundColor: theme.colors.surface2 },
}));
