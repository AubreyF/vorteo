import { useCallback, useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { GridRowTracker } from "./grid-row-tracker";

export type { GridRowTracker } from "./grid-row-tracker";

/** Native grids need no marker; web uses it to find the grid node. */
export const CARD_GRID_DATASET = undefined;

/**
 * Native layout `y` is already relative to the grid line, and native onLayout fires when a view
 * moves, so each tile reports its own row.
 */
export function useGridRows(_compact: ReadonlyMap<string, number>): GridRowTracker {
  const [rows, setRows] = useState<ReadonlyMap<string, number>>(new Map());
  const onTileLayout = useCallback((id: string, event: LayoutChangeEvent) => {
    const { width, y } = event.nativeEvent.layout;
    if (width <= 0) return;
    const row = Math.round(y);
    setRows((previous) => {
      if (previous.get(id) === row) return previous;
      return new Map(previous).set(id, row);
    });
  }, []);
  const schedule = useCallback(() => {}, []);
  return useMemo(() => ({ rows, onTileLayout, schedule }), [rows, onTileLayout, schedule]);
}
