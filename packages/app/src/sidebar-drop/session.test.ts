import { afterEach, describe, expect, test } from "vitest";
import { EMPTY_SIDEBAR_FOLDER_STATE, type SidebarFolderState } from "@/sidebar-folders/store";
import { dragViewCollapsedProjects, dragViewFolderState, useSidebarDragSession } from "./session";

const ROOT = { kind: "root" } as const;
const folder = (id: string, parentId: string | null) => ({
  id,
  name: id,
  parentId,
  scope: ROOT,
  createdAt: "2026-10-28T00:00:00Z",
});

const stored: SidebarFolderState = {
  ...EMPTY_SIDEBAR_FOLDER_STATE,
  sidebarFolders: {
    work: folder("work", null),
    client: folder("client", "work"),
    personal: folder("personal", null),
    bugs: {
      ...folder("bugs", null),
      scope: { kind: "project", projectKey: "app" },
    },
  },
  itemFolder: { app: "client" },
  collapsedFolders: { personal: false, work: false },
};
const storedProjects = new Set(["site"]);
const projectKeys = ["app", "site", "docs"];

function view() {
  const session = useSidebarDragSession.getState().session;
  return {
    folders: dragViewFolderState(stored, session),
    projects: dragViewCollapsedProjects(storedProjects, projectKeys, session),
  };
}

afterEach(() => useSidebarDragSession.getState().end());

describe("collapse during a drag", () => {
  test("dragging a project folds every project and every root folder not holding it", () => {
    useSidebarDragSession.getState().begin({ key: "app", kind: "project" });
    const { folders, projects } = view();
    expect([...projects]).toEqual(projectKeys);
    expect(folders.collapsedFolders).toEqual({ personal: true, work: false });
  });

  test("a dragged root folder folds itself", () => {
    useSidebarDragSession.getState().begin({ key: "folder:work", kind: "rootFolder" });
    expect(view().folders.collapsedFolders).toMatchObject({ work: true, personal: true });
  });

  test("workspace drags leave folding alone", () => {
    useSidebarDragSession.getState().begin({ key: "host:ws", kind: "workspace" });
    expect(view().folders).toBe(stored);
    expect(view().projects).toBe(storedProjects);
  });

  for (const ending of ["drop", "cancel"]) {
    test(`folding is restored exactly after ${ending}`, () => {
      const before = structuredClone(stored);
      useSidebarDragSession.getState().begin({ key: "app", kind: "project" });
      expect(view().folders).not.toBe(stored);
      // Drops and cancels both end the session; neither writes the temporary folding.
      useSidebarDragSession.getState().end();
      expect(view().folders).toBe(stored);
      expect(view().projects).toBe(storedProjects);
      expect(stored).toEqual(before);
    });
  }
});
