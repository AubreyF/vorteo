import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
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
  return (
    <Button
      variant="ghost"
      size="sm"
      style={[
        taskCardStyles.accordionTrigger,
        touch && taskCardStyles.touchAccordionTrigger,
        compact && styles.compact,
      ]}
      textStyle={taskCardStyles.heading}
      accessibilityLabel={title}
      aria-expanded={expanded}
      accessibilityState={accessibilityState}
      onPress={onPress}
      testID={testID}
      trailing={
        <>
          <View testID={`${testID}-arrow`}>
            {expanded ? <Down size={16} /> : <Right size={16} />}
          </View>
          {count}
        </>
      }
    >
      {title}
    </Button>
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
  compact: { flex: 0, flexShrink: 1 },
  body: { gap: theme.spacing[1] },
  collapsed: { display: "none" },
}));
