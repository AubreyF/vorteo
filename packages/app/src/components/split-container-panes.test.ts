import { describe, expect, it } from "vitest";
import { hasMultipleVisiblePanes, splitNodeContainsPane } from "@/components/split-container-panes";
import type { SplitNode } from "@/stores/workspace-layout-store";

const pane = (id: string): SplitNode => ({
  kind: "pane",
  pane: { id, tabIds: [], focusedTabId: null },
});
const hiddenPane = (id: string): SplitNode => ({
  kind: "pane",
  pane: { id, tabIds: [], focusedTabId: null, hidden: true },
});
const root: SplitNode = {
  kind: "group",
  group: {
    id: "root",
    direction: "horizontal",
    children: [pane("left"), pane("right")],
    sizes: [0.5, 0.5],
  },
};

describe("split pane geometry", () => {
  it("finds the maximized pane without replacing the rendered split tree", () => {
    expect(splitNodeContainsPane(root, "right")).toBe(true);
    expect(splitNodeContainsPane(root, "missing")).toBe(false);
  });

  it("offers pane maximize only when another pane is visible", () => {
    expect(hasMultipleVisiblePanes(root)).toBe(true);
    expect(hasMultipleVisiblePanes(pane("left"))).toBe(false);
    expect(
      hasMultipleVisiblePanes({
        ...root,
        group: { ...root.group, children: [pane("left"), hiddenPane("right")] },
      }),
    ).toBe(false);
  });
});
