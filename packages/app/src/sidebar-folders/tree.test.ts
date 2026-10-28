import { describe, expect, test } from "vitest";
import {
  applySidebarStatePatch,
  emptySidebarState,
  type SidebarFolder,
  type SidebarFolderScope,
} from "@getpaseo/protocol/sidebar-state";
import { EMPTY_SIDEBAR_FOLDER_STATE, type SidebarFolderState } from "./store";
import {
  buildSidebarTreeRows,
  createSidebarFolderPatch,
  flattenSidebarScope,
  listSidebarFolderDestinations,
  moveSidebarEntryPatch,
  reorderSidebarRowsPatch,
  type SidebarTreeRow,
} from "./tree";

const ROOT: SidebarFolderScope = { kind: "root" };

function folder(id: string, parentId: string | null, scope: SidebarFolderScope = ROOT) {
  return {
    id,
    name: id.toUpperCase(),
    parentId,
    scope,
    createdAt: `2026-10-22T00:00:0${id.length}Z`,
  };
}

function folderState(
  folders: SidebarFolder[],
  extra: Partial<SidebarFolderState> = {},
): SidebarFolderState {
  return {
    ...EMPTY_SIDEBAR_FOLDER_STATE,
    sidebarFolders: Object.fromEntries(folders.map((entry) => [entry.id, entry])),
    ...extra,
  };
}

function describeRows(rows: SidebarTreeRow<string>[]): string[] {
  return rows.map(
    (row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? row.folder.name : row.item}`,
  );
}

function rowsFor(state: SidebarFolderState, items: string[], hideEmptyFolders = false) {
  return buildSidebarTreeRows({
    state,
    scope: ROOT,
    items,
    getKey: (item) => item,
    hideEmptyFolders,
  });
}

describe("sidebar folder tree", () => {
  test("renders folders nested more than three levels with their items", () => {
    const state = folderState(
      [folder("a", null), folder("b", "a"), folder("c", "b"), folder("d", "c"), folder("e", "d")],
      { itemFolder: { deep: "e", top: "a" }, childOrder: { root: ["folder:a", "loose"] } },
    );
    expect(describeRows(rowsFor(state, ["loose", "deep", "top"]))).toEqual([
      "A",
      "  top",
      "  B",
      "    C",
      "      D",
      "        E",
      "          deep",
      "loose",
    ]);
  });

  test("collapsed folders hide their contents and count every item below them", () => {
    const state = folderState([folder("a", null), folder("b", "a")], {
      itemFolder: { one: "a", two: "b" },
      collapsedFolders: { a: true },
    });
    const rows = rowsFor(state, ["one", "two", "three"]);
    expect(describeRows(rows)).toEqual(["three", "A"]);
    expect(rows[1]).toMatchObject({ kind: "folder", collapsed: true, itemCount: 2 });
  });

  test("filters hide folders that contain no visible item", () => {
    const state = folderState([folder("a", null), folder("bb", null)], {
      itemFolder: { one: "a" },
    });
    expect(describeRows(rowsFor(state, ["one"], true))).toEqual(["A", "  one"]);
    expect(describeRows(rowsFor(state, ["one"]))).toEqual(["A", "  one", "BB"]);
  });

  test("items missing from the stored order keep their flat position", () => {
    const state = folderState([folder("a", null)], {
      childOrder: { root: ["y", "folder:a", "z"] },
    });
    expect(describeRows(rowsFor(state, ["new", "y", "z", "last"]))).toEqual([
      "new",
      "y",
      "A",
      "z",
      "last",
    ]);
  });

  test("moving a project into a folder writes the tree and the flat order older clients read", () => {
    const state = folderState([folder("a", null)], {
      childOrder: { root: ["folder:a", "p", "q"] },
    });
    const patch = moveSidebarEntryPatch({
      state,
      scope: ROOT,
      entry: "q",
      targetFolderId: "a",
      before: null,
      keys: ["p", "q"],
    });
    expect(patch).toEqual({
      childOrder: { root: ["folder:a", "p"], "folder:a": ["q"] },
      itemFolder: { q: "a" },
      projectOrder: ["q", "p"],
    });
    const stored = applySidebarStatePatch(
      { ...emptySidebarState(), ...state, projectOrder: ["p", "q"] },
      patch!,
    );
    expect(stored.projectOrder).toEqual(["q", "p"]);
    expect(stored.itemFolder).toEqual({ q: "a" });
  });

  test("placing after a listed sibling keeps a hidden sibling after it in order", () => {
    // A filter lists p and r but not q; dropping s after p must not jump past q.
    const state = folderState([], { childOrder: { root: ["p", "q", "r", "s"] } });
    const patch = moveSidebarEntryPatch({
      state,
      scope: ROOT,
      entry: "s",
      targetFolderId: null,
      before: null,
      after: "p",
      keys: ["p", "q", "r", "s"],
    });
    expect(patch?.childOrder).toEqual({ root: ["p", "s", "q", "r"] });
  });

  test("moving to the top level removes the folder assignment", () => {
    const state = folderState([folder("a", null)], { itemFolder: { q: "a" } });
    const patch = moveSidebarEntryPatch({
      state,
      scope: ROOT,
      entry: "q",
      targetFolderId: null,
      before: null,
      keys: ["q"],
    });
    expect(patch?.itemFolder).toEqual({ q: null });
  });

  test("a folder cannot move into itself or its descendants", () => {
    const state = folderState([folder("a", null), folder("b", "a"), folder("c", "b")]);
    const move = (targetFolderId: string) =>
      moveSidebarEntryPatch({
        state,
        scope: ROOT,
        entry: "folder:a",
        targetFolderId,
        before: null,
        keys: [],
      });
    expect(move("a")).toBeNull();
    expect(move("c")).toBeNull();
    expect(
      listSidebarFolderDestinations({ state, scope: ROOT, movingFolderId: "b" }).map(
        (destination) => destination.folder.id,
      ),
    ).toEqual(["a"]);
  });

  test("a dropped row joins the folder of the row below it", () => {
    const state = folderState([folder("a", null)], {
      itemFolder: { inside: "a" },
      childOrder: { root: ["p", "folder:a"], "folder:a": ["inside"] },
    });
    const rows = rowsFor(state, ["p", "inside"]);
    expect(describeRows(rows)).toEqual(["p", "A", "  inside"]);
    const dropped = [rows[1]!, rows[0]!, rows[2]!];
    expect(
      reorderSidebarRowsPatch({
        state,
        scope: ROOT,
        rows: dropped,
        movedKey: "p",
        keys: ["p", "inside"],
      }),
    ).toMatchObject({ itemFolder: { p: "a" }, childOrder: { "folder:a": ["p", "inside"] } });
    expect(
      reorderSidebarRowsPatch({ state, scope: ROOT, rows, movedKey: "p", keys: ["p", "inside"] }),
    ).toBeNull();
  });

  test("project folders order workspaces and flatten into that project's order", () => {
    const scope: SidebarFolderScope = { kind: "project", projectKey: "proj" };
    const created = createSidebarFolderPatch({
      state: EMPTY_SIDEBAR_FOLDER_STATE,
      scope,
      parentId: null,
      folder: { id: "f", name: "Later", createdAt: "2026-10-22T00:00:00Z" },
      keys: ["s:1", "s:2"],
    });
    expect(created.childOrder).toEqual({ "project:proj": ["s:1", "s:2", "folder:f"] });
    const state = folderState([folder("f", null, scope)], {
      childOrder: created.childOrder as Record<string, string[]>,
      itemFolder: { "s:1": "f" },
    });
    expect(flattenSidebarScope({ state, scope, keys: ["s:1", "s:2"] })).toEqual(["s:2", "s:1"]);
    const patch = moveSidebarEntryPatch({
      state,
      scope,
      entry: "s:2",
      targetFolderId: "f",
      before: "s:1",
      keys: ["s:1", "s:2"],
    });
    expect(patch?.workspaceOrderByProject).toEqual({ proj: ["s:2", "s:1"] });
  });
});
