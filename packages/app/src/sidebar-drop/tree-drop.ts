import { useMemo, useRef } from "react";
import { SIDEBAR_INDENT_UNIT, sidebarIndent } from "@/components/sidebar/indent";
import type { DraggableListTreeDrop } from "@/components/draggable-list.types";
import {
  resolveSidebarDrop,
  type SidebarDragKind,
  type SidebarDropPlacement,
  type SidebarDropRow,
  type SidebarDropTop,
} from "./resolve";
import { useSidebarDragSession } from "./session";

function shifted(row: SidebarDropRow, shift: number): SidebarDropRow {
  return {
    key: row.key,
    kind: row.kind,
    depth: row.depth - shift,
    expanded: row.expanded,
    projectKey: row.projectKey,
    section: row.section,
  };
}

function dragKindOf(kind: SidebarDropRow["kind"]): SidebarDragKind | null {
  return kind === "section" ? null : kind;
}

/** Keys in their new order after a placement, for lists that store a flat order. */
export function reorderKeys(
  keys: readonly string[],
  moved: string,
  placement: Pick<SidebarDropPlacement, "beforeKey" | "afterKey">,
): string[] {
  const rest = keys.filter((key) => key !== moved);
  let index = rest.length;
  if (placement.beforeKey !== null) index = rest.indexOf(placement.beforeKey);
  else if (placement.afterKey !== null) index = rest.indexOf(placement.afterKey) + 1;
  rest.splice(index < 0 ? rest.length : index, 0, moved);
  return rest;
}

/**
 * Binds one sidebar list to the drop resolver. `focusRootKey` names the focused row at the
 * top of a focused list: it becomes the container of the rows below it rather than a target.
 */
export function useSidebarTreeDrop<T>(input: {
  items: readonly T[];
  describe: (item: T) => SidebarDropRow;
  top: SidebarDropTop;
  /** Hierarchy level of the list's depth-0 rows. */
  baseLevel: number;
  focusRootKey: string | null;
  outside: "clamp" | "cancel";
  onDrop: (dragged: SidebarDropRow, placement: SidebarDropPlacement) => void;
}): DraggableListTreeDrop<T, SidebarDropPlacement> {
  const { items, describe, top, baseLevel, focusRootKey, outside, onDrop } = input;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  return useMemo(() => {
    const described = items.map(describe);
    const focusRoot = described.find((row) => row.key === focusRootKey) ?? null;
    const shift = focusRoot ? 1 : 0;
    const rows = described.flatMap((row) => (row === focusRoot ? [] : [shifted(row, shift)]));
    const listTop: SidebarDropTop = focusRoot
      ? {
          key: focusRoot.key,
          kind: focusRoot.kind,
          projectKey: focusRoot.projectKey,
          section: focusRoot.section,
        }
      : top;
    const byKey = new Map(described.map((row) => [row.key, row]));
    return {
      indentUnit: SIDEBAR_INDENT_UNIT,
      baseInset: sidebarIndent(baseLevel + shift),
      depthOf: (item) => describe(item).depth - shift,
      outside,
      resolve: (drop) => {
        const row = byKey.get(drop.activeKey);
        const kind = row ? dragKindOf(row.kind) : null;
        if (!row || kind === null || row === focusRoot) return null;
        const overFocusRoot = drop.overKey === focusRoot?.key;
        return resolveSidebarDrop({
          rows,
          top: listTop,
          dragged: { key: row.key, kind, projectKey: row.projectKey, section: row.section },
          overKey: overFocusRoot ? (rows[0]?.key ?? row.key) : drop.overKey,
          overFraction: overFocusRoot ? 0 : drop.overFraction,
          pointerX: drop.pointerX,
          rowContentStartX: drop.rowContentStartX,
          previousDepth: drop.previousDepth,
        });
      },
      onDrop: (activeKey, placement) => {
        const row = byKey.get(activeKey);
        if (row) onDropRef.current(row, placement);
      },
      onDragStart: (activeKey) => {
        const kind = dragKindOf(byKey.get(activeKey)?.kind ?? "section");
        if (kind) useSidebarDragSession.getState().begin({ key: activeKey, kind });
      },
      onDragEnd: () => useSidebarDragSession.getState().end(),
    };
  }, [items, describe, top, baseLevel, focusRootKey, outside]);
}
