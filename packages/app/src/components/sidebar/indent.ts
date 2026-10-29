import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

/**
 * One sidebar hierarchy level: a 16px icon slot plus the 8px gap before its title, so each
 * child's icon sits under its parent's title. Root folders, projects, project folders with
 * Standing and Factory, and workspaces each step in by exactly this much, and drag depth
 * projection measures in the same unit.
 */
export const SIDEBAR_INDENT_UNIT = 24;

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
