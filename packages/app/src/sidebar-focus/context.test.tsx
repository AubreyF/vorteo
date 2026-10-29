// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarFocusController } from "./context";
import type { SidebarFocusWorld } from "./model";
import { useSidebarFocusStore } from "./store";

const world: SidebarFocusWorld = {
  folders: {},
  itemFolder: {},
  projects: new Map([["app", { name: "App", sections: [] }]]),
  hiddenFolderIds: new Set(),
};

function renderController() {
  return renderHook(() => useSidebarFocusController({ world, enabled: true }));
}

beforeEach(() => {
  useSidebarFocusStore.setState({
    focus: { target: { kind: "project", projectKey: "app" }, ancestors: [] },
  });
});

describe("sidebar focus controller", () => {
  it("leaves focus only through focusOn(null), as the All projects crumb does", () => {
    const { result } = renderController();
    expect(result.current.focus).toEqual({ kind: "project", projectKey: "app" });
    act(() => {
      result.current.focusOn(null);
    });
    expect(useSidebarFocusStore.getState().focus).toBeNull();
    expect(result.current.focus).toBeNull();
  });

  it("stores the ancestors of a newly focused item for later fallback", () => {
    const { result } = renderController();
    act(() => {
      result.current.focusOn({
        kind: "section",
        projectKey: "app",
        section: "standing",
      });
    });
    expect(useSidebarFocusStore.getState().focus).toEqual({
      target: { kind: "section", projectKey: "app", section: "standing" },
      ancestors: [{ kind: "project", projectKey: "app" }],
    });
  });
});
