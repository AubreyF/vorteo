import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useVortonTouch } from "@/vorton-touch";
import { taskCardStyles } from "./task-card-styles";

const Down = withUnistyles(ChevronDown, (theme) => ({ color: theme.colors.foregroundMuted }));
const Right = withUnistyles(ChevronRight, (theme) => ({ color: theme.colors.foregroundMuted }));

/** Consistent disclosure order: title, arrow, then the optional count. */
export function CardDisclosure({
  title,
  status,
  expanded,
  onPress,
  count,
  testID,
  icon,
  trailing,
}: {
  title: string;
  status?: string;
  expanded: boolean;
  onPress: () => void;
  count?: ReactNode;
  testID: string;
  icon: ReactNode;
  trailing?: ReactNode;
}) {
  const touch = useVortonTouch();
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const [hovered, setHovered] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  return (
    <View style={styles.hoverTarget} onPointerEnter={enter} onPointerLeave={leave}>
      <Pressable
        style={[
          taskCardStyles.accordionTrigger,
          styles.trigger,
          hovered && styles.hovered,
          touch && taskCardStyles.touchAccordionTrigger,
        ]}
        accessibilityRole="button"
        accessibilityLabel={status ? `${title} (${status})` : title}
        aria-expanded={expanded}
        accessibilityState={accessibilityState}
        onPress={onPress}
        testID={testID}
      >
        {icon}
        <Text
          style={[taskCardStyles.heading, styles.title]}
          numberOfLines={1}
          testID={`${testID}-title`}
        >
          {title}
          {status ? (
            <Text style={styles.status} testID={`${testID}-status`}>
              {" "}
              ({status})
            </Text>
          ) : null}
        </Text>
        <View testID={`${testID}-arrow`} style={styles.arrow}>
          {expanded ? <Down size={16} /> : <Right size={16} />}
        </View>
        {count}
        {trailing}
      </Pressable>
    </View>
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
  hoverTarget: { flex: 1, minWidth: 0, marginLeft: -theme.spacing[3] },
  trigger: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",
    borderRadius: theme.borderRadius.md,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
  },
  hovered: { backgroundColor: theme.colors.interactionHighlight },
  status: {
    fontSize: Math.round(theme.fontSize.sm * 0.8),
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  title: { flexShrink: 1, minWidth: 0 },
  arrow: { width: 16, height: 16, flexShrink: 0 },
  body: { gap: theme.spacing[1] },
  collapsed: { display: "none" },
}));
