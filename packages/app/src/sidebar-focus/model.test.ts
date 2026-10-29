import { describe, expect, test } from "vitest";
import type { SidebarFolder, SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import { EMPTY_SIDEBAR_FOLDER_STATE } from "@/sidebar-folders/store";
import { buildSidebarTreeRows } from "@/sidebar-folders/tree";
import {
  expandSidebarFocusPath,
  focusTreeRows,
  resolveSidebarFocus,
  sidebarFocusAncestors,
  sidebarFocusRootRowKey,
  sidebarFocusTrail,
  type SidebarFocusProject,
  type SidebarFocusTarget,
  type SidebarFocusWorld,
} from "./model";

const ROOT: SidebarFolderScope = { kind: "root" };
const LABELS = { allProjects: "All projects", standing: "Standing", factory: "Factory" };

function folder(id: string, parentId: string | null, scope: SidebarFolderScope = ROOT) {
  return { id, name: id.toUpperCase(), parentId, scope, createdAt: "2026-10-28T00:00:00Z" };
}

function world(input: {
  folders: SidebarFolder[];
  itemFolder?: Record<string, string>;
  projects?: Record<string, SidebarFocusProject>;
  hiddenFolderIds?: string[];
}): SidebarFocusWorld {
  return {
    folders: Object.fromEntries(input.folders.map((entry) => [entry.id, entry])),
    itemFolder: input.itemFolder ?? {},
    projects: new Map(Object.entries(input.projects ?? {})),
    hiddenFolderIds: new Set(input.hiddenFolderIds ?? []),
  };
}

// Root folder "work" > nested root folder "client" > project "app" > project folder "bugs" >
// project folder "urgent".
const chain = world({
  folders: [
    folder("work", null),
    folder("client", "work"),
    folder("bugs", null, { kind: "project", projectKey: "app" }),
    folder("urgent", "bugs", { kind: "project", projectKey: "app" }),
  ],
  itemFolder: { app: "client" },
  projects: {
    app: { name: "App", sections: ["standing"] },
    site: { name: "Site", sections: [] },
  },
});

const urgent: SidebarFocusTarget = { kind: "folder", folderId: "urgent" };

describe("sidebar focus breadcrumb", () => {
  test("lists root folders, the project and project folders above the focused folder", () => {
    expect(
      sidebarFocusTrail({ target: urgent, world: chain, labels: LABELS }).map(
        (crumb) => crumb.label,
      ),
    ).toEqual(["All projects", "WORK", "CLIENT", "App", "BUGS", "URGENT"]);
  });

  test("starts with All projects, which leaves focus", () => {
    const [first] = sidebarFocusTrail({ target: urgent, world: chain, labels: LABELS });
    expect(first).toEqual({ key: "all", label: "All projects", target: null });
  });

  test("names Standing under its project", () => {
    const trail = sidebarFocusTrail({
      target: { kind: "section", projectKey: "app", section: "standing" },
      world: chain,
      labels: LABELS,
    });
    expect(trail.map((crumb) => crumb.label)).toEqual([
      "All projects",
      "WORK",
      "CLIENT",
      "App",
      "Standing",
    ]);
  });

  test("a project at the top level has only All projects above it", () => {
    expect(sidebarFocusAncestors({ kind: "project", projectKey: "site" }, chain)).toEqual([]);
  });
});

describe("sidebar focus fallback", () => {
  const stored = { target: urgent, ancestors: sidebarFocusAncestors(urgent, chain) };

  test("keeps a listed target", () => {
    expect(resolveSidebarFocus(stored, chain)).toEqual(urgent);
  });

  test("falls back to the parent folder when the focused folder is deleted", () => {
    const deleted = world({
      folders: [
        folder("work", null),
        folder("client", "work"),
        folder("bugs", null, { kind: "project", projectKey: "app" }),
      ],
      itemFolder: { app: "client" },
      projects: { app: { name: "App", sections: [] } },
    });
    expect(resolveSidebarFocus(stored, deleted)).toEqual({ kind: "folder", folderId: "bugs" });
  });

  test("falls back past a removed project to its root folder", () => {
    const archived = world({
      folders: [folder("work", null), folder("client", "work")],
      itemFolder: {},
      projects: {},
    });
    expect(resolveSidebarFocus(stored, archived)).toEqual({ kind: "folder", folderId: "client" });
  });

  test("falls back when a filter hides the focused folder", () => {
    const filtered = { ...chain, hiddenFolderIds: new Set(["urgent", "bugs"]) };
    expect(resolveSidebarFocus(stored, filtered)).toEqual({ kind: "project", projectKey: "app" });
  });

  test("returns to all projects when nothing on the path remains", () => {
    expect(resolveSidebarFocus(stored, world({ folders: [] }))).toBeNull();
  });

  test("falls back from an empty Standing section to its project", () => {
    const target: SidebarFocusTarget = { kind: "section", projectKey: "site", section: "standing" };
    expect(resolveSidebarFocus({ target, ancestors: [] }, chain)).toEqual({
      kind: "project",
      projectKey: "site",
    });
  });
});

describe("rows while focused", () => {
  const state = {
    ...EMPTY_SIDEBAR_FOLDER_STATE,
    sidebarFolders: { work: folder("work", null), client: folder("client", "work") },
    itemFolder: { app: "client", api: "work" },
    collapsedFolders: { work: true },
  };
  const rows = (focus: SidebarFocusTarget) =>
    buildSidebarTreeRows({
      state: expandSidebarFocusPath(
        state,
        focus,
        world({ folders: Object.values(state.sidebarFolders), itemFolder: state.itemFolder }),
      ),
      scope: ROOT,
      items: ["app", "api", "site"],
      getKey: (item) => item,
      hideEmptyFolders: false,
    });

  test("a focused root folder shows itself at the top level with its contents", () => {
    const focus: SidebarFocusTarget = { kind: "folder", folderId: "work" };
    const shown = focusTreeRows(rows(focus), "folder:work");
    expect(shown.map((row) => `${row.depth}:${row.key}`)).toEqual([
      "0:folder:work",
      "1:api",
      "1:folder:client",
      "2:app",
    ]);
  });

  test("a focused project inside folded folders shows only that project", () => {
    const focus: SidebarFocusTarget = { kind: "project", projectKey: "app" };
    const focusWorld = world({
      folders: Object.values(state.sidebarFolders),
      itemFolder: state.itemFolder,
      projects: { app: { name: "App", sections: [] } },
    });
    const key = sidebarFocusRootRowKey(focus, focusWorld);
    expect(focusTreeRows(rows(focus), key).map((row) => `${row.depth}:${row.key}`)).toEqual([
      "0:app",
    ]);
  });

  test("unfolding for focus never touches the stored collapse state", () => {
    rows({ kind: "folder", folderId: "client" });
    expect(state.collapsedFolders).toEqual({ work: true });
  });
});
