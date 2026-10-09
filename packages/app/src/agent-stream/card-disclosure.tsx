import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useVortonTouch } from "@/vorton-touch";
import { taskCardStyles } from "./task-card-styles";

const Down = withUnistyles(ChevronDown, (theme) => ({ color: theme.colors.foregroundMuted }));
const Right = withUnistyles(ChevronRight, (theme) => ({ color: theme.colors.foregroundMuted }));

/** Consistent disclosure order: title, arrow, then the optional count. */
export function CardDisclosure({
  title,
  expanded,
  onPress,
  count,
  testID,
  compact = false,
}: {
  title: string;
  expanded: boolean;
  onPress: () => void;
  count?: ReactNode;
  testID: string;
  compact?: boolean;
}) {
  const touch = useVortonTouch();
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const triggerStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      taskCardStyles.accordionTrigger,
      styles.trigger,
      hovered && styles.hovered,
      touch && taskCardStyles.touchAccordionTrigger,
      compact && styles.compact,
    ],
    [touch, compact],
  );
  return (
    <Pressable
      style={triggerStyle}
      accessibilityRole="button"
      accessibilityLabel={title}
      aria-expanded={expanded}
      accessibilityState={accessibilityState}
      onPress={onPress}
      testID={testID}
    >
      <Text style={[taskCardStyles.heading, styles.title]} numberOfLines={1}>
        {title}
      </Text>
      <View testID={`${testID}-arrow`} style={styles.arrow}>
        {expanded ? <Down size={16} /> : <Right size={16} />}
      </View>
      {count}
    </Pressable>
  );
}
/** Keep local drafts and row state mounted while the card is folded. */
export function CollapsibleCardBody({
  expanded,
  testID,
  children,
}: {
  expanded: boolean;
  testID: string;
  children: ReactNode;
}) {
  return (
    <View style={[styles.body, !expanded && styles.collapsed]} testID={testID}>
      {children}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  trigger: { borderRadius: theme.borderRadius.md },
  hovered: { backgroundColor: theme.colors.interactionHighlight },
  compact: { flexGrow: 0, flexShrink: 1, flexBasis: "auto" },
  title: { flexShrink: 1, minWidth: 0 },
  arrow: { width: 16, height: 16, flexShrink: 0 },
  body: { gap: theme.spacing[1] },
  collapsed: { display: "none" },
}));
