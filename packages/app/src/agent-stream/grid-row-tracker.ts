import type { LayoutChangeEvent } from "react-native";

export interface GridRowTracker {
  /** Grid-relative top of each collapsed tile, keyed by card id. */
  rows: ReadonlyMap<string, number>;
  onTileLayout: (id: string, event: LayoutChangeEvent) => void;
  /** Re-measure after something other than a tile's own resize may have moved tiles. */
  schedule: () => void;
}
