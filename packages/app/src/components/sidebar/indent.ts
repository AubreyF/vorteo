import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

/**
 * One sidebar hierarchy level. Root folders, projects, project folders with Standing and
 * Factory, and workspaces each step in by exactly this much, and drag depth projection, the
 * drop indicator and drop hit areas measure in the same unit.
 */
export const SIDEBAR_INDENT_UNIT = 12;

/** Where a level-0 row's leading icon slot starts. */
export const SIDEBAR_ROW_INSET = 6;

/** Left padding of a row at `level`, measured from the sidebar list's edge. */
export function sidebarIndent(level: number): number {
  return SIDEBAR_ROW_INSET + level * SIDEBAR_INDENT_UNIT;
}

export function sidebarIndentStyle(level: number) {
  return inlineUnistylesStyle({ paddingLeft: sidebarIndent(level) });
}

/** Shifts a whole block, such as a project inside root folders, by `levels` units. */
export function sidebarNestingStyle(levels: number) {
  return inlineUnistylesStyle({ paddingLeft: levels * SIDEBAR_INDENT_UNIT });
}
