import type { SplitNode } from "@/stores/workspace-layout-store";

/** Whether a split subtree contains the pane currently projected full-size. */
export function splitNodeContainsPane(node: SplitNode, paneId: string): boolean {
  if (node.kind === "pane") return node.pane.id === paneId;
  return node.group.children.some((child) => splitNodeContainsPane(child, paneId));
}

/** Whether a workspace pane has another visible pane it can be maximized over. */
export function hasMultipleVisiblePanes(node: SplitNode): boolean {
  let visiblePaneCount = 0;
  const visit = (current: SplitNode): void => {
    if (current.kind === "pane") {
      if (current.pane.hidden !== true) visiblePaneCount += 1;
      return;
    }
    for (const child of current.group.children) {
      visit(child);
      if (visiblePaneCount > 1) return;
    }
  };
  visit(node);
  return visiblePaneCount > 1;
}
