export const COLUMN_BREAKPOINT = 1080;
export const COLUMN_MARGIN = 16;
export const CARD_GAP = 8;
export const COLUMN_GAP = COLUMN_MARGIN * 2;
export const MIN_TEXT_WIDTH = 560;
export const MIN_CARDS_WIDTH = 220;
export const MAX_TEXT_WIDTH = 1600;
export const MAX_CARDS_WIDTH = 760;
export const COLUMN_FADE_HEIGHT = 64;

export interface ColumnWidths {
  text: number;
  cards: number;
}

export function resolveStandaloneTextWidth(containerWidth: number, preferred: number): number {
  return Math.max(0, Math.min(preferred, MAX_TEXT_WIDTH, containerWidth - COLUMN_MARGIN * 2));
}

export function resolveColumnWidths(containerWidth: number, preferred: ColumnWidths): ColumnWidths {
  const available = Math.max(
    MIN_TEXT_WIDTH + MIN_CARDS_WIDTH,
    containerWidth - COLUMN_MARGIN * 2 - COLUMN_GAP,
  );
  const cards = Math.max(
    MIN_CARDS_WIDTH,
    Math.min(preferred.cards, MAX_CARDS_WIDTH, available - MIN_TEXT_WIDTH),
  );
  return {
    cards,
    text: Math.max(MIN_TEXT_WIDTH, Math.min(preferred.text, MAX_TEXT_WIDTH, available - cards)),
  };
}

/** Text expands around its center; the card column expands from its fixed right edge. */
export function resizeColumn(input: {
  column: keyof ColumnWidths;
  initial: ColumnWidths;
  translation: number;
  containerWidth: number;
  standaloneText?: boolean;
}): ColumnWidths {
  const { column, initial, translation, containerWidth } = input;
  const requested = { ...initial };
  requested[column] += column === "text" ? translation * 2 : -translation;
  if (input.standaloneText)
    return {
      cards: 0,
      text: resolveStandaloneTextWidth(containerWidth, Math.max(MIN_TEXT_WIDTH, requested.text)),
    };
  return resolveColumnWidths(containerWidth, requested);
}

/** Prefer the composer center, stopping at the card column's reserved gutter. */
export function resolveTextOffset(containerWidth: number, widths: ColumnWidths): number {
  const centered = (containerWidth - widths.text) / 2;
  const besideCards = containerWidth - COLUMN_MARGIN - widths.cards - COLUMN_GAP - widths.text;
  return Math.max(COLUMN_MARGIN, Math.min(centered, besideCards));
}

/** Small cards keep their natural height; larger cards share the remaining space equally. */
export function allocateCardHeights(available: number, demands: readonly number[]): number[] {
  let remaining = Math.max(0, available - Math.max(0, demands.length - 1) * CARD_GAP);
  let count = demands.length;
  let ceiling = 0;
  for (const demand of [...demands].sort((a, b) => a - b)) {
    ceiling = remaining / count;
    if (demand >= ceiling) break;
    remaining -= demand;
    count -= 1;
  }
  return demands.map((demand) => Math.min(demand, ceiling));
}

export interface CardGridDemand {
  height: number;
  /** Undefined for accessory rows, which do not participate in disclosure layout. */
  expanded?: boolean;
  /** Collapsed tiles on the same measured flex line consume one row. */
  row?: number;
}

export interface GridLine {
  ids: string[];
  top: number;
  bottom: number;
}

/**
 * Group collapsed tiles into flex lines. Rows are measured against the grid in one pass (see
 * grid-row), so tiles on one line agree; this guard still joins tiles whose tops differ by less
 * than half a tile height, while genuinely wrapped lines sit a full tile plus a gap apart. A
 * joined line reserves its full extent, so a real visual offset is never clipped.
 */
export function groupGridLines(
  tiles: Iterable<{ id: string; top: number; height: number }>,
): GridLine[] {
  const lines: GridLine[] = [];
  for (const { id, top, height } of tiles) {
    const bottom = top + height;
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.top - top) < Math.min(height, candidate.bottom - candidate.top) / 2,
    );
    if (!line) {
      lines.push({ ids: [id], top, bottom });
      continue;
    }
    line.ids.push(id);
    line.top = Math.min(line.top, top);
    line.bottom = Math.max(line.bottom, bottom);
  }
  return lines;
}

/** Changes only when tiles change lines or a line's reserved extent changes. */
export function gridLineSignature(lines: readonly GridLine[]): string {
  return lines
    .map((line) => `${[...line.ids].sort().join(",")}:${Math.round(line.bottom - line.top)}`)
    .sort()
    .join("|");
}

export function allocateGridCardHeights(
  available: number,
  demands: ReadonlyMap<string, CardGridDemand>,
): ReadonlyMap<string, number> {
  const tiles: { id: string; top: number; height: number }[] = [];
  const flexible: [string, number][] = [];
  const heights = new Map<string, number>();
  for (const [id, demand] of demands) {
    if (demand.row === undefined) flexible.push([id, demand.height]);
    else {
      tiles.push({ id, top: demand.row, height: demand.height });
      heights.set(id, demand.height);
    }
  }
  const lines = groupGridLines(tiles);
  const fixedHeight = lines.reduce((sum, line) => sum + line.bottom - line.top, 0);
  const gaps = Math.max(0, lines.length + flexible.length - 1) * CARD_GAP;
  const remaining = Math.max(0, available - fixedHeight - gaps);
  // The existing allocator accounts for gaps between the flexible cards itself.
  const allocations = allocateCardHeights(
    remaining + Math.max(0, flexible.length - 1) * CARD_GAP,
    flexible.map(([, height]) => height),
  );
  flexible.forEach(([id], index) => heights.set(id, allocations[index]));
  return heights;
}
