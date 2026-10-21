import { CardGrid, cardGridExpandedStyle } from "../card-grid";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { CARD_GAP, allocateGridCardHeights, type CardGridDemand } from "./geometry";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useGridRows } from "../grid-row";

interface CardDemand {
  height: number;
  /** Collapsed tiles share flex lines; the column measures their rows itself. */
  compact?: boolean;
  /** Undefined for accessory rows, which do not participate in disclosure layout. */
  expanded?: boolean;
}

/** Natural heights of collapsed tiles, which the row tracker measures. */
function compactHeights(demands: ReadonlyMap<string, CardDemand>): Map<string, number> {
  const compact = new Map<string, number>();
  for (const [id, demand] of demands) if (demand.compact) compact.set(id, demand.height);
  return compact;
}

/** Collapsed tiles whose row is not measured yet are budgeted like flexible cards. */
function gridDemands(
  demands: ReadonlyMap<string, CardDemand>,
  rows: ReadonlyMap<string, number>,
): Map<string, CardGridDemand> {
  const grid = new Map<string, CardGridDemand>();
  for (const [id, { height, compact, expanded }] of demands) {
    grid.set(id, { height, expanded, row: compact ? rows.get(id) : undefined });
  }
  return grid;
}

interface CardColumnLayout {
  heights: ReadonlyMap<string, number>;
  allCollapsed: boolean;
  measure: (id: string, height: number | null, compact?: boolean, expanded?: boolean) => void;
  onTileLayout: (id: string, event: LayoutChangeEvent) => void;
}
export const CardColumnContext = createContext<CardColumnLayout | null>(null);

export function CardColumn({ children }: { children: ReactNode }) {
  const active = useRetainedPanelActive();
  const [height, setHeight] = useState(0);
  const [demands, setDemands] = useState<ReadonlyMap<string, CardDemand>>(new Map());
  const compact = useMemo(() => compactHeights(demands), [demands]);
  const { rows, onTileLayout, schedule } = useGridRows(compact);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (event.nativeEvent.layout.height > 0) setHeight(event.nativeEvent.layout.height);
      schedule();
    },
    [schedule],
  );
  const measure = useCallback(
    (id: string, demand: number | null, isCompact?: boolean, expanded?: boolean) => {
      setDemands((previous) => {
        const before = previous.get(id);
        if (
          (before?.height === demand &&
            before?.compact === isCompact &&
            before?.expanded === expanded) ||
          (demand === null && !before)
        )
          return previous;
        const next = new Map(previous);
        if (demand === null) next.delete(id);
        else next.set(id, { height: demand, compact: isCompact, expanded });
        return next;
      });
    },
    [],
  );
  const value = useMemo(() => {
    const heights = allocateGridCardHeights(height, gridDemands(demands, rows));
    const cards = [...demands.values()].filter((demand) => demand.expanded !== undefined);
    const allCollapsed = cards.length > 0 && cards.every((card) => !card.expanded);
    return { heights, measure, onTileLayout, allCollapsed };
  }, [height, demands, rows, measure, onTileLayout]);
  return (
    <View
      style={columnStyle}
      onLayout={onLayout}
      testID={active ? "thread-cards-stack" : undefined}
    >
      <CardColumnContext.Provider value={value}>
        <CardGrid style={gridColumnStyle} testID={active ? "agent-history-task-cards" : undefined}>
          {children}
        </CardGrid>
      </CardColumnContext.Provider>
    </View>
  );
}
const gridColumnStyle = { flex: 1, minHeight: 0, overflow: "hidden" } as const;
const columnStyle = { flex: 1, minHeight: 0, gap: CARD_GAP, overflow: "hidden" } as const;

/** Include non-card content in the same height budget as the surrounding cards. */
export function CardColumnAccessory({ children }: { children: ReactNode }) {
  const column = useContext(CardColumnContext);
  const active = useRetainedPanelActive();
  const id = useId();
  const [height, setHeight] = useState(0);
  const measure = column?.measure;
  useLayoutEffect(() => {
    measure?.(id, active && height > 0 ? height : null);
  }, [measure, id, active, height]);
  useLayoutEffect(() => () => measure?.(id, null), [measure, id]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height: measured } = event.nativeEvent.layout;
    if (width > 0) setHeight(measured);
  }, []);
  return (
    <View style={[accessoryStyle, cardGridExpandedStyle]} onLayout={onLayout}>
      {children}
    </View>
  );
}
const accessoryStyle = { flexShrink: 0 } as const;
