/**
 * Native counterpart of `row-highlight.web.ts`. Native panes have no DOM to
 * search, so jumps land on the pane and rows are not marked. Signatures match
 * the web module so callers type-check once.
 */

export function settingsPaneDomId(paneId: string): string {
  return `settings-pane-${paneId}`;
}

export function findSettingRow(_paneId: string, _label: string): HTMLElement | null {
  return null;
}

export function flashSettingRow(_row: HTMLElement): void {}

export function markSettingRows(
  _matches: ReadonlyArray<{ pane: string; label: string }>,
): () => void {
  return () => {};
}

export function rowOffsetWithin(_row: HTMLElement, _scrollNode: HTMLElement): number {
  return 0;
}
