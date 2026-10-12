import { COLUMN_BREAKPOINT } from "@/agent-stream/columns/geometry";
import { useCallback, useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import { usePanelStore } from "@/stores/panel-store";
import { SIDEBAR_OUTER_GAP, resolveResponsiveSidebar } from "@/stores/panel-store/state";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import { useIsCompactFormFactor } from "@/constants/layout";

export function useResponsiveSidebar() {
  const { width: viewportWidth } = useWindowDimensions();
  const isMobile = useIsCompactFormFactor();
  const sidebarCompact = usePanelStore((state) => state.sidebarCompact);
  const sidebarNarrow = usePanelStore((state) => state.sidebarNarrow);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const sidebarViewportOverride = usePanelStore((state) => state.sidebarViewportOverride);
  useEffect(() => {
    if (sidebarViewportOverride !== null && sidebarViewportOverride !== viewportWidth) {
      usePanelStore.setState({ sidebarViewportOverride: null });
    }
  }, [sidebarViewportOverride, viewportWidth]);
  const mode = resolveResponsiveSidebar(
    { sidebarCompact, sidebarNarrow, sidebarWidth, sidebarViewportOverride },
    viewportWidth,
  );
  return {
    ...mode,
    viewportWidth,
    automaticallyCompact: mode.sidebarCompact && !sidebarCompact,
    visibleWidth: isMobile
      ? 0
      : resolveDesktopSidebarWidth({
          requestedWidth: sidebarWidth,
          viewportWidth,
          compact: mode.sidebarCompact,
          narrow: mode.sidebarNarrow,
        }) +
        SIDEBAR_OUTER_GAP * 2,
  };
}

/** Explicit opens survive until the next resize; automatic collapse never becomes a preference. */
export function useResponsiveSupportingCards(manuallyCollapsed: boolean) {
  const { viewportWidth, visibleWidth, automaticallyCompact, sidebarCompact } =
    useResponsiveSidebar();
  const [overrideWidth, setOverrideWidth] = useState<number | null>(null);
  useEffect(() => {
    setOverrideWidth(null);
  }, [viewportWidth]);
  const reveal = useCallback(() => setOverrideWidth(viewportWidth), [viewportWidth]);
  return {
    sidebarCompact,
    collapsed:
      manuallyCollapsed ||
      ((automaticallyCompact || viewportWidth - visibleWidth < COLUMN_BREAKPOINT) &&
        overrideWidth !== viewportWidth),
    reveal,
  };
}
