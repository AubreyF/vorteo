import { Tooltip, TooltipTrigger, TooltipContent, TooltipText } from "@/components/ui/tooltip";
import { CardTileContext } from "./card-grid";
import { CompactCountBadgeContext } from "@/components/ui/count-badge";
import { TruncatedText } from "@/components/ui/truncated-text";
import { FLOATING_PANEL_RADIUS } from "@/styles/floating-panel";
import { useCallback, useMemo, useState, useContext, useEffect, type ReactNode } from "react";
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

function renderTrailing(trailing: ReactNode, compact: boolean) {
  return compact ? null : trailing;
}

function CardDisclosureHint({
  enabled,
  label,
  children,
}: {
  enabled: boolean;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const reveal = useCallback(() => setOpen(true), []);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  return (
    <Tooltip
      open={enabled && open}
      onOpenChange={setOpen}
      enabledOnDesktop={enabled}
      enabledOnMobile={enabled}
    >
      <TooltipTrigger asChild passive onLongPress={reveal}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" offset={8}>
        <TooltipText label={label} />
      </TooltipContent>
    </Tooltip>
  );
}

function disclosureLayout(
  tile: React.ContextType<typeof CardTileContext>,
  width: number,
  metadataWidth: number,
) {
  const compact = tile.compact ? tile.width < 190 : width < 132 + metadataWidth;
  return {
    compact,
    stacked: tile.compact && tile.width < 100,
    hideMetadata: !tile.compact && width < 48 + metadataWidth,
    compactTile: tile.compact && compact,
  };
}

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
  const tile = useContext(CardTileContext);
  const [width, setWidth] = useState(Infinity);
  const [metadataWidth, setMetadataWidth] = useState(0);
  const measure = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.width > 0) setWidth(event.nativeEvent.layout.width);
  }, []);
  const measureMetadata = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.width > 0) setMetadataWidth(event.nativeEvent.layout.width);
  }, []);
  // Reserve the icon, insets and gaps before admitting text or trailing chips.
  const { compact, stacked, hideMetadata, compactTile } = disclosureLayout(
    tile,
    width,
    metadataWidth,
  );
  const countLayout = useMemo(
    () => ({ compact: tile.compact, narrow: stacked }),
    [tile.compact, stacked],
  );
  const label = status ? `${title} (${status})` : title;
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
      <CardDisclosureHint enabled={!expanded} label={label}>
        <Pressable
          style={[
            taskCardStyles.accordionTrigger,
            styles.trigger,
            hovered && styles.hovered,
            touch && taskCardStyles.touchAccordionTrigger,
            touch && styles.touchTrigger,
            compactTile && styles.compactTrigger,
            stacked && styles.stackedTrigger,
          ]}
          accessibilityRole="button"
          accessibilityLabel={label}
          aria-expanded={expanded}
          accessibilityState={accessibilityState}
          onPress={onPress}
          testID={testID}
        >
          {icon}
          <TruncatedText
            tooltipLabel={expanded ? label : ""}
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
              style={[
                styles.metadata,
                compactTile && styles.compactMetadata,
                stacked && styles.stackedMetadata,
                hideMetadata && styles.collapsed,
              ]}
              testID={`${testID}-metadata`}
            >
              {renderTrailing(trailing, compactTile)}
              <CompactCountBadgeContext value={countLayout}>{count}</CompactCountBadgeContext>
            </View>
          ) : null}
        </Pressable>
      </CardDisclosureHint>
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
  compactTrigger: { justifyContent: "center", paddingHorizontal: 2, gap: 4 },
  stackedTrigger: {
    flexDirection: "column",
    height: "auto",
    minHeight: 56,
    paddingVertical: 4,
    gap: 2,
  },
  compactMetadata: { marginLeft: 0, minWidth: 0, flexShrink: 1 },
  stackedMetadata: { maxWidth: "100%", justifyContent: "center", flexWrap: "wrap", gap: 2 },
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
