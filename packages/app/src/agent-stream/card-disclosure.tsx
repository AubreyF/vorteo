import { TruncatedText } from "@/components/ui/truncated-text";
import { FLOATING_PANEL_RADIUS } from "@/styles/floating-panel";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useVortonTouch } from "@/vorton-touch";
import {
  TASK_CARD_ICON_CENTER,
  TASK_CARD_TOUCH_ICON_CENTER,
  taskCardStyles,
} from "./task-card-styles";

const Down = withUnistyles(ChevronDown, (theme) => ({ color: theme.colors.foregroundMuted }));
const Right = withUnistyles(ChevronRight, (theme) => ({ color: theme.colors.foregroundMuted }));

/** Counts stay at the trailing edge inside the complete heading hover target. */
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
  const [width, setWidth] = useState(Infinity);
  const [metadataWidth, setMetadataWidth] = useState(0);
  const measure = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.width > 0) setWidth(event.nativeEvent.layout.width);
  }, []);
  const measureMetadata = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.width > 0) setMetadataWidth(event.nativeEvent.layout.width);
  }, []);
  // Reserve the icon, insets and gaps before admitting text or trailing chips.
  const compact = width < 132 + metadataWidth;
  const hideMetadata = width < 48 + metadataWidth;
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const [hovered, setHovered] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  return (
    <View
      style={styles.hoverTarget}
      onLayout={measure}
      onPointerEnter={enter}
      onPointerLeave={leave}
    >
      <Pressable
        style={[
          taskCardStyles.accordionTrigger,
          styles.trigger,
          hovered && styles.hovered,
          touch && taskCardStyles.touchAccordionTrigger,
          touch && styles.touchTrigger,
        ]}
        accessibilityRole="button"
        accessibilityLabel={status ? `${title} (${status})` : title}
        aria-expanded={expanded}
        accessibilityState={accessibilityState}
        onPress={onPress}
        testID={testID}
      >
        {icon}
        <TruncatedText
          tooltipLabel={status ? `${title} (${status})` : title}
          style={[taskCardStyles.heading, styles.title, compact && styles.collapsed]}
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
        </TruncatedText>
        <View testID={`${testID}-arrow`} style={[styles.arrow, compact && styles.collapsed]}>
          {expanded ? <Down size={16} /> : <Right size={16} />}
        </View>
        {count || trailing ? (
          <View
            onLayout={measureMetadata}
            style={[styles.metadata, hideMetadata && styles.collapsed]}
            testID={`${testID}-metadata`}
          >
            {trailing}
            {count}
          </View>
        ) : null}
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
  hoverTarget: { flex: 1, minWidth: 0 },
  trigger: {
    borderRadius: FLOATING_PANEL_RADIUS,
    paddingLeft: TASK_CARD_ICON_CENTER - 10,
    paddingRight: theme.spacing[2],
  },
  touchTrigger: { paddingLeft: TASK_CARD_TOUCH_ICON_CENTER - 10 },
  metadata: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
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
