import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { VORTON_HEADER_HEIGHT } from "@/constants/layout";
import { panelHeaderInset, usePanelSpacing } from "./use-panel-spacing";

const SidebarSpacingContext = createContext({
  inset: 2,
  headerHeight: VORTON_HEADER_HEIGHT + 4,
  onLayout: (_event: LayoutChangeEvent) => {},
  setCompact: (_compact: boolean) => {},
});

/** One animation clock keeps navigation padding, tabs and workspace actions aligned. */
export function SidebarSpacingProvider({ children }: { children: ReactNode }) {
  const { inset, onLayout } = usePanelSpacing();
  const [compact, setCompact] = useState(false);
  const value = useMemo(
    () => ({
      inset,
      headerHeight: VORTON_HEADER_HEIGHT + (compact ? 0 : panelHeaderInset(inset) * 2),
      onLayout,
      setCompact,
    }),
    [inset, onLayout, compact],
  );
  return <SidebarSpacingContext.Provider value={value}>{children}</SidebarSpacingContext.Provider>;
}

export const useSidebarSpacing = () => useContext(SidebarSpacingContext);
