export const COLUMN_BREAKPOINT = 1080;
export const COLUMN_MARGIN = 16;
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
}): ColumnWidths {
  const { column, initial, translation, containerWidth } = input;
  const requested = { ...initial };
  requested[column] += column === "text" ? translation * 2 : -translation;
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
  let remaining = Math.max(0, available - Math.max(0, demands.length - 1) * COLUMN_MARGIN);
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
