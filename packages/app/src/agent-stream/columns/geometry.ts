export const COLUMN_BREAKPOINT = 1080;
export const COLUMN_MARGIN = 28;
export const COLUMN_GAP = 24;
export const MIN_TEXT_WIDTH = 560;
export const MIN_CARDS_WIDTH = 440;
export const MAX_TEXT_WIDTH = 1600;
export const MAX_CARDS_WIDTH = 760;
export const COLUMN_FADE_HEIGHT = 64;

export interface ColumnWidths {
  text: number;
  cards: number;
}

export function resolveColumnWidths(containerWidth: number, preferred: ColumnWidths): ColumnWidths {
  const available = Math.max(1000, containerWidth - COLUMN_MARGIN * 2 - COLUMN_GAP);
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
