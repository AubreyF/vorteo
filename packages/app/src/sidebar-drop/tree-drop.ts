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
 * Binds one sidebar list to the drop resolver. A focused list passes the focused container as
 * `top`, so its depth-0 rows land in that container.
 */
export function useSidebarTreeDrop<T>(input: {
  items: readonly T[];
  describe: (item: T) => SidebarDropRow;
  top: SidebarDropTop;
  /** Hierarchy level of the list's depth-0 rows. */
  baseLevel: number;
  outside: "clamp" | "cancel";
  onDrop: (dragged: SidebarDropRow, placement: SidebarDropPlacement) => void;
}): DraggableListTreeDrop<T, SidebarDropPlacement> {
  const { items, describe, top, baseLevel, outside, onDrop } = input;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  return useMemo(() => {
    const rows = items.map(describe);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return {
      indentUnit: SIDEBAR_INDENT_UNIT,
      baseInset: sidebarIndent(baseLevel),
      depthOf: (item) => describe(item).depth,
      outside,
      resolve: (drop) => {
        const row = byKey.get(drop.activeKey);
        const kind = row ? dragKindOf(row.kind) : null;
        if (!row || kind === null) return null;
        return resolveSidebarDrop({
          rows,
          top,
          dragged: { key: row.key, kind, projectKey: row.projectKey, section: row.section },
          overKey: drop.overKey,
          overFraction: drop.overFraction,
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
  }, [items, describe, top, baseLevel, outside]);
}
