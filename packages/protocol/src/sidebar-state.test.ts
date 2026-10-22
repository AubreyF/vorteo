import { describe, expect, test } from "vitest";
import { SidebarFolderPatchError } from "./sidebar-folders.js";
import {
  SidebarStatePatchSchema,
  SidebarStateSchema,
  applySidebarStatePatch,
  emptySidebarState,
  mergeSidebarStatePatch,
  type SidebarFolder,
  type SidebarFolderScope,
  type SidebarState,
} from "./sidebar-state.js";

const ROOT: SidebarFolderScope = { kind: "root" };

function folder(id: string, parentId: string | null, scope: SidebarFolderScope = ROOT) {
  return { id, name: id, parentId, scope, createdAt: "2026-10-22T00:00:00.000Z" };
}

function stateWith(folders: SidebarFolder[], extra: Partial<SidebarState> = {}): SidebarState {
  return {
    ...emptySidebarState(),
    sidebarFolders: Object.fromEntries(folders.map((entry) => [entry.id, entry])),
    itemFolder: {},
    childOrder: {},
    collapsedFolders: {},
    ...extra,
  };
}

function parents(state: SidebarState): Record<string, string | null> {
  return Object.fromEntries(
    Object.values(state.sidebarFolders ?? {}).map((entry) => [entry.id, entry.parentId]),
  );
}

describe("sidebar folder state", () => {
  test("older states without folder fields stay unchanged by ordinary patches", () => {
    const state = applySidebarStatePatch(emptySidebarState(), { projectOrder: ["a", "b"] });
    expect(state).toEqual({ ...emptySidebarState(), projectOrder: ["a", "b"] });
    expect("sidebarFolders" in state).toBe(false);
  });

  test("an older client's schema ignores the folder fields it does not know", () => {
    const legacy = SidebarStateSchema.pick({ projectOrder: true, workspaceOrderByProject: true });
    const state = stateWith([folder("f", null)], {
      projectOrder: ["a", "b"],
      itemFolder: { a: "f" },
    });
    expect(legacy.parse(state)).toEqual({ projectOrder: ["a", "b"], workspaceOrderByProject: {} });
  });

  test("merging patches keeps removals so they reach the stored state", () => {
    const merged = mergeSidebarStatePatch(
      { sidebarFolders: { a: folder("a", null) }, itemFolder: { p: "a" } },
      { sidebarFolders: { a: null, b: folder("b", null) }, itemFolder: { q: "b" } },
    );
    expect(merged.sidebarFolders).toEqual({ a: null, b: folder("b", null) });
    expect(merged.itemFolder).toEqual({ p: "a", q: "b" });
    expect(SidebarStatePatchSchema.parse(merged)).toEqual(merged);
  });

  test("nests folders more than three levels deep", () => {
    const chain = ["a", "b", "c", "d", "e"].map((id, index, ids) =>
      folder(id, index === 0 ? null : ids[index - 1]!),
    );
    const state = applySidebarStatePatch(stateWith([]), {
      sidebarFolders: Object.fromEntries(chain.map((entry) => [entry.id, entry])),
      itemFolder: { project: "e" },
    });
    expect(parents(state)).toEqual({ a: null, b: "a", c: "b", d: "c", e: "d" });
    expect(state.itemFolder).toEqual({ project: "e" });
  });

  test("a move that would form a cycle returns to its previous parent", () => {
    const state = stateWith([folder("a", null), folder("b", "a"), folder("c", "b")]);
    const next = applySidebarStatePatch(state, { sidebarFolders: { a: folder("a", "c") } });
    expect(parents(next)).toEqual({ a: null, b: "a", c: "b" });
  });

  test("concurrent moves into each other keep the first accepted move", () => {
    const state = stateWith([folder("x", null), folder("y", null)]);
    const first = applySidebarStatePatch(state, { sidebarFolders: { x: folder("x", "y") } });
    const second = applySidebarStatePatch(first, { sidebarFolders: { y: folder("y", "x") } });
    expect(parents(second)).toEqual({ x: "y", y: null });
  });

  test("rejects a folder that names itself as parent", () => {
    expect(() =>
      applySidebarStatePatch(stateWith([]), { sidebarFolders: { a: folder("a", "a") } }),
    ).toThrow(SidebarFolderPatchError);
  });

  test("parents must exist and share the folder's scope", () => {
    const project: SidebarFolderScope = { kind: "project", projectKey: "p" };
    const next = applySidebarStatePatch(stateWith([folder("root", null)]), {
      sidebarFolders: {
        inner: folder("inner", "root", project),
        orphan: folder("orphan", "missing"),
      },
    });
    expect(parents(next)).toEqual({ root: null, inner: null, orphan: null });
  });

  test("projects map only to root folders and workspaces only to their own project", () => {
    const project: SidebarFolderScope = { kind: "project", projectKey: "p" };
    const other: SidebarFolderScope = { kind: "project", projectKey: "q" };
    const state = stateWith(
      [folder("root", null), folder("pf", null, project), folder("qf", null, other)],
      { projectOrder: ["p", "q"], workspaceOrderByProject: { p: ["s:w1", "s:w2"] } },
    );
    const next = applySidebarStatePatch(state, {
      itemFolder: { p: "pf", q: "root", "s:w1": "pf", "s:w2": "qf", "s:new": "pf", "s:x": "root" },
    });
    expect(next.itemFolder).toEqual({ q: "root", "s:w1": "pf", "s:new": "pf", "s:x": "root" });
  });

  test("removing a folder moves its folders, items and order to its parent", () => {
    const state = stateWith([folder("top", null), folder("mid", "top"), folder("leaf", "mid")], {
      projectOrder: ["a", "b", "c"],
      itemFolder: { a: "mid", b: "leaf", c: "top" },
      childOrder: {
        root: ["folder:top"],
        "folder:top": ["c", "folder:mid"],
        "folder:mid": ["folder:leaf", "a"],
        "folder:leaf": ["b"],
      },
      collapsedFolders: { mid: true },
    });
    const next = applySidebarStatePatch(state, { sidebarFolders: { mid: null } });
    expect(parents(next)).toEqual({ top: null, leaf: "top" });
    expect(next.itemFolder).toEqual({ a: "top", b: "leaf", c: "top" });
    expect(next.childOrder).toEqual({
      root: ["folder:top"],
      "folder:top": ["c", "folder:leaf", "a"],
      "folder:leaf": ["b"],
    });
    expect(next.collapsedFolders).toEqual({});
  });

  test("removing nested folders together lifts everything to the surviving ancestor", () => {
    const state = stateWith([folder("top", null), folder("mid", "top")], {
      projectOrder: ["a", "b"],
      itemFolder: { a: "top", b: "mid" },
      childOrder: {
        root: ["x", "folder:top", "y"],
        "folder:top": ["folder:mid", "a"],
        "folder:mid": ["b"],
      },
    });
    const next = applySidebarStatePatch(state, { sidebarFolders: { top: null, mid: null } });
    expect(next.sidebarFolders).toEqual({});
    expect(next.itemFolder).toEqual({});
    expect(next.childOrder).toEqual({ root: ["x", "b", "a", "y"] });
  });
});
