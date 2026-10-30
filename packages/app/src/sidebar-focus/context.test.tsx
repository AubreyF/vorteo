// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { focusSidebarProject, useSidebarFocusController } from "./context";
import { EMPTY_SIDEBAR_FOLDER_STATE, useSidebarFolderStore } from "@/sidebar-folders/store";
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

describe("focusing a project from the compact rail", () => {
  it("stores the same focus as the project row's Focus button, with its folder ancestors", () => {
    const folder = (id: string, parentId: string | null) => ({
      id,
      name: id,
      parentId,
      scope: { kind: "root" as const },
      createdAt: "2026-10-29T00:00:00Z",
    });
    useSidebarFolderStore.setState({
      ...EMPTY_SIDEBAR_FOLDER_STATE,
      sidebarFolders: { work: folder("work", null), client: folder("client", "work") },
      itemFolder: { app: "client" },
    });
    useSidebarFocusStore.setState({ focus: null });
    const { result } = renderHook(() =>
      useSidebarFocusController({
        world: {
          folders: useSidebarFolderStore.getState().sidebarFolders,
          itemFolder: useSidebarFolderStore.getState().itemFolder,
          projects: new Map([["app", { name: "App", sections: [] }]]),
          hiddenFolderIds: new Set(),
        },
        enabled: true,
      }),
    );
    act(() => {
      result.current.focusOn({ kind: "project", projectKey: "app" });
    });
    const fromButton = useSidebarFocusStore.getState().focus;
    useSidebarFocusStore.setState({ focus: null });
    act(() => {
      focusSidebarProject("app");
    });
    expect(useSidebarFocusStore.getState().focus).toEqual(fromButton);
    expect(fromButton).toEqual({
      target: { kind: "project", projectKey: "app" },
      ancestors: [
        { kind: "folder", folderId: "work" },
        { kind: "folder", folderId: "client" },
      ],
    });
    expect(result.current.focus).toEqual({ kind: "project", projectKey: "app" });
    useSidebarFolderStore.setState(EMPTY_SIDEBAR_FOLDER_STATE);
  });
});
