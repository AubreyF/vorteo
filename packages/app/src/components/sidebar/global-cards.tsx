import { useCallback, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlobalOpenQuestionsCard } from "@/open-questions/global-card";
import { GlobalQuotaCard } from "@/provider-usage/global-quota-card";
import { SIDEBAR_OUTER_GAP } from "@/stores/panel-store/state";
import {
  GlobalCardLayoutContext,
  globalCardLayout,
  type GlobalCardKind,
} from "./global-card-shell";

/**
 * Global cards between the workspace list and the sidebar footer. Each card hides itself while
 * it has nothing to show, so an idle installation keeps the full list. On desktop the cards are
 * `detached`: they sit below the floating navigation card, separated by the panel gap.
 */
export function SidebarGlobalCards({
  onBeforeNavigate,
  detached = false,
}: {
  onBeforeNavigate?: () => void;
  detached?: boolean;
}) {
  const { height } = useWindowDimensions();
  const [shown, setShownState] = useState<ReadonlySet<GlobalCardKind>>(() => new Set());
  const setShown = useCallback((kind: GlobalCardKind, visible: boolean) => {
    setShownState((current) => {
      if (current.has(kind) === visible) return current;
      const next = new Set(current);
      if (visible) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);
  const layout = useMemo(
    () => ({ ...globalCardLayout(height), shown, setShown }),
    [height, setShown, shown],
  );
  return (
    <GlobalCardLayoutContext.Provider value={layout}>
      <View
        style={[styles.stack, detached && shown.size > 0 && styles.detached]}
        testID="sidebar-global-cards"
      >
        <GlobalOpenQuestionsCard onBeforeNavigate={onBeforeNavigate} />
        <GlobalQuotaCard />
      </View>
    </GlobalCardLayoutContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { flexShrink: 0, gap: theme.spacing[2] },
  detached: { marginTop: SIDEBAR_OUTER_GAP },
}));
