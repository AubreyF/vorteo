import { SIDEBAR_INDENT_UNIT } from "@/components/sidebar/indent";

export type SidebarDropRowKind =
  | "rootFolder"
  | "project"
  | "projectFolder"
  | "section"
  | "workspace";
export type SidebarDragKind = "rootFolder" | "project" | "projectFolder" | "workspace";
export type SidebarDropSection = "standing" | "factory";

/** One visible sidebar row, in display order. */
export interface SidebarDropRow {
  key: string;
  kind: SidebarDropRowKind;
  /** Hierarchy depth below the list's top container; its direct children are at 0. */
  depth: number;
  /** Containers only: whether their children are listed below them. */
  expanded: boolean;
  /** The project a project-scoped row belongs to, or the project row's own key. */
  projectKey: string | null;
  /** Section rows, and workspaces inside Standing or Factory. */
  section: SidebarDropSection | null;
}

/** The container that holds depth-0 rows: null for the sidebar's top level. */
export type SidebarDropTop = Omit<SidebarDropRow, "depth" | "expanded"> | null;

export interface SidebarDraggedItem {
  key: string;
  kind: SidebarDragKind;
  projectKey: string | null;
  section: SidebarDropSection | null;
}

export interface SidebarDropPlacement {
  mode: "between" | "into";
  /** Key of the receiving container; null for the sidebar's top level. */
  container: string | null;
  /** Position among the container's listed children after the dragged row is removed. */
  index: number;
  /** Depth of the dropped row, which also places the insertion line. */
  depth: number;
  /** The listed sibling the row lands before, or null at the end of the listed siblings. */
  beforeKey: string | null;
  /**
   * The listed sibling the row lands after, or null at the start. With `beforeKey` null it
   * places the row among siblings a filter or focus does not list.
   */
  afterKey: string | null;
  /** Between drops: the row the insertion line sits above, or null for below the last row. */
  lineBeforeKey: string | null;
}

export interface SidebarDropInput {
  rows: readonly SidebarDropRow[];
  top: SidebarDropTop;
  dragged: SidebarDraggedItem;
  /** The row under the pointer; the dragged row's own key while over its original slot. */
  overKey: string;
  /** Pointer height within the row under it, from 0 at its top to 1 at its bottom. */
  overFraction: number;
  /** Horizontal position of the dragged row's leading edge. */
  pointerX: number;
  /** Where depth-0 content starts, in the same coordinates as `pointerX`. */
  rowContentStartX: number;
  /** The depth chosen on the previous move, for hysteresis. */
  previousDepth: number | null;
}

/** Extra distance, in indent units, before the projected depth leaves its previous value. */
export const SIDEBAR_DEPTH_HYSTERESIS = 0.25;

type Container = Omit<SidebarDropRow, "depth" | "expanded"> | null;

function isRootLevel(kind: SidebarDragKind): boolean {
  return kind === "project" || kind === "rootFolder";
}

/**
 * The type rules. Projects and root folders live at the top level or in root folders. Workspaces
 * and project folders stay in their project's ordinary list and its folders; Standing and
 * Factory workspaces stay in their section. A workspace enters another project only by an
 * `into` drop on that project's header.
 */
function canContain(input: {
  container: Container;
  dragged: SidebarDraggedItem;
  mode: SidebarDropPlacement["mode"];
}): boolean {
  const { container, dragged, mode } = input;
  if (container === null) return isRootLevel(dragged.kind);
  if (container.key === dragged.key) return false;
  switch (container.kind) {
    case "rootFolder":
      return isRootLevel(dragged.kind);
    case "project":
      if (isRootLevel(dragged.kind)) return false;
      if (container.key !== dragged.projectKey) {
        return mode === "into" && dragged.kind === "workspace";
      }
      return dragged.section === null;
    case "projectFolder":
      return (
        !isRootLevel(dragged.kind) &&
        container.projectKey === dragged.projectKey &&
        dragged.section === null
      );
    case "section":
      return (
        mode === "between" &&
        dragged.kind === "workspace" &&
        container.projectKey === dragged.projectKey &&
        container.section === dragged.section
      );
    case "workspace":
      return false;
  }
}

/** Rows with the dragged row and everything beneath it removed. */
function withoutDragged(
  rows: readonly SidebarDropRow[],
  draggedKey: string,
): { rows: SidebarDropRow[]; origin: number; originDepth: number | null } {
  const start = rows.findIndex((row) => row.key === draggedKey);
  if (start < 0) return { rows: [...rows], origin: rows.length, originDepth: null };
  const originDepth = rows[start]!.depth;
  let end = start + 1;
  while (end < rows.length && rows[end]!.depth > originDepth) end += 1;
  return { rows: [...rows.slice(0, start), ...rows.slice(end)], origin: start, originDepth };
}

/** The container a row at `depth` would join when inserted at `gap`. */
function parentAt(input: {
  rows: readonly SidebarDropRow[];
  gap: number;
  depth: number;
  top: SidebarDropTop;
}): Container | undefined {
  const { rows, gap, depth, top } = input;
  if (depth === 0) return top;
  for (let index = gap - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.depth === depth - 1) return row;
    if (row.depth < depth - 1) return undefined;
  }
  return undefined;
}

function legalDepths(input: {
  rows: readonly SidebarDropRow[];
  gap: number;
  top: SidebarDropTop;
  dragged: SidebarDraggedItem;
}): number[] {
  const { rows, gap, top, dragged } = input;
  const previous = rows[gap - 1];
  const next = rows[gap];
  const min = next?.depth ?? 0;
  // A collapsed container takes rows through its middle zone, never as an unseen first child.
  const opensBelow = previous !== undefined && previous.expanded;
  const max = previous === undefined ? 0 : previous.depth + (opensBelow ? 1 : 0);
  const depths: number[] = [];
  for (let depth = min; depth <= max; depth += 1) {
    const container = parentAt({ rows, gap, depth, top });
    if (container !== undefined && canContain({ container, dragged, mode: "between" })) {
      depths.push(depth);
    }
  }
  return depths;
}

function projectDepth(input: {
  depths: readonly number[];
  pointerX: number;
  rowContentStartX: number;
  previousDepth: number | null;
}): number {
  const { depths, previousDepth } = input;
  const raw = (input.pointerX - input.rowContentStartX) / SIDEBAR_INDENT_UNIT;
  if (
    previousDepth !== null &&
    depths.includes(previousDepth) &&
    Math.abs(raw - previousDepth) < 0.5 + SIDEBAR_DEPTH_HYSTERESIS
  ) {
    return previousDepth;
  }
  const min = depths[0]!;
  const max = depths[depths.length - 1]!;
  const projected = Math.min(max, Math.max(min, Math.round(raw)));
  return depths.reduce((best, depth) =>
    Math.abs(depth - projected) < Math.abs(best - projected) ? depth : best,
  );
}

function betweenPlacement(input: {
  rows: readonly SidebarDropRow[];
  gap: number;
  depth: number;
  top: SidebarDropTop;
}): SidebarDropPlacement {
  const { rows, gap, depth, top } = input;
  const container = parentAt({ rows, gap, depth, top }) ?? null;
  const next = rows[gap];
  let index = 0;
  let afterKey: string | null = null;
  for (let position = gap - 1; position >= 0; position -= 1) {
    const row = rows[position]!;
    if (row.depth < depth) break;
    if (row.depth !== depth) continue;
    afterKey ??= row.key;
    index += 1;
  }
  return {
    mode: "between",
    container: container?.key ?? null,
    index,
    depth,
    beforeKey: next?.depth === depth ? next.key : null,
    afterKey,
    lineBeforeKey: next?.key ?? null,
  };
}

function intoPlacement(
  rows: readonly SidebarDropRow[],
  target: SidebarDropRow,
): SidebarDropPlacement {
  const start = rows.indexOf(target);
  let index = 0;
  let afterKey: string | null = null;
  for (let position = start + 1; position < rows.length; position += 1) {
    const row = rows[position]!;
    if (row.depth <= target.depth) break;
    if (row.depth !== target.depth + 1) continue;
    afterKey = row.key;
    index += 1;
  }
  return {
    mode: "into",
    container: target.key,
    index,
    depth: target.depth + 1,
    beforeKey: null,
    afterKey,
    lineBeforeKey: null,
  };
}

/**
 * Top quarter, middle half and bottom quarter on a row that takes the dragged item, halves
 * elsewhere. A quarter whose neighbouring position is illegal joins the middle.
 */
function zoneOf(input: {
  fraction: number;
  accepts: boolean;
  beforeLegal: boolean;
  afterLegal: boolean;
}): "before" | "into" | "after" {
  const { fraction, accepts } = input;
  if (!accepts) return fraction < 0.5 ? "before" : "after";
  if (fraction < 0.25 && input.beforeLegal) return "before";
  if (fraction > 0.75 && input.afterLegal) return "after";
  return "into";
}

/** The legal gap nearest `gap`, searching outward. Only projects and root folders snap. */
function nearestLegalGap(input: {
  rows: readonly SidebarDropRow[];
  gap: number;
  top: SidebarDropTop;
  dragged: SidebarDraggedItem;
}): number | null {
  const { rows, gap } = input;
  for (let distance = 1; distance <= rows.length; distance += 1) {
    for (const candidate of [gap - distance, gap + distance]) {
      if (candidate < 0 || candidate > rows.length) continue;
      if (legalDepths({ ...input, gap: candidate }).length > 0) return candidate;
    }
  }
  return null;
}

/**
 * Where a dragged sidebar row lands, or null when the drop would break the type rules and
 * there is no legal position to snap to.
 */
export function resolveSidebarDrop(input: SidebarDropInput): SidebarDropPlacement | null {
  const { top, dragged } = input;
  const { rows, origin, originDepth } = withoutDragged(input.rows, dragged.key);
  const overIndex = rows.findIndex((row) => row.key === input.overKey);
  const target = rows[overIndex];
  let gap: number;
  if (target === undefined) {
    gap = origin;
  } else {
    const accepts = canContain({ container: target, dragged, mode: "into" });
    const zone = zoneOf({
      fraction: input.overFraction,
      accepts,
      beforeLegal: legalDepths({ rows, gap: overIndex, top, dragged }).length > 0,
      afterLegal: legalDepths({ rows, gap: overIndex + 1, top, dragged }).length > 0,
    });
    if (zone === "into") return intoPlacement(rows, target);
    gap = zone === "before" ? overIndex : overIndex + 1;
  }
  let depths = legalDepths({ rows, gap, top, dragged });
  if (depths.length === 0) {
    if (!isRootLevel(dragged.kind)) return null;
    const snapped = nearestLegalGap({ rows, gap, top, dragged });
    if (snapped === null) return null;
    gap = snapped;
    depths = legalDepths({ rows, gap, top, dragged });
  }
  const depth = projectDepth({
    depths,
    pointerX: input.pointerX,
    rowContentStartX: input.rowContentStartX,
    previousDepth: input.previousDepth,
  });
  // Back in its own slot at its own depth: nothing moves.
  if (gap === origin && depth === originDepth) return null;
  return betweenPlacement({ rows, gap, depth, top });
}
