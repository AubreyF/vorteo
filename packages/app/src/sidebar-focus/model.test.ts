import { describe, expect, test } from "vitest";
import type { SidebarFolder, SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import { EMPTY_SIDEBAR_FOLDER_STATE } from "@/sidebar-folders/store";
import { buildSidebarTreeRows } from "@/sidebar-folders/tree";
import {
  expandSidebarFocusPath,
  focusTreeRows,
  resolveSidebarFocus,
  sidebarBreadcrumbActionsVisible,
  sidebarFocusAncestors,
  sidebarFocusRootDropTop,
  sidebarFocusRootRows,
  sidebarProjectBlockLevels,
  sidebarFocusTrail,
  sidebarRowFocusVisibility,
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

  const focusWorld = world({
    folders: Object.values(state.sidebarFolders),
    itemFolder: state.itemFolder,
    projects: {
      app: { name: "App", sections: [] },
      api: { name: "API", sections: [] },
      site: { name: "Site", sections: [] },
    },
  });
  const shownRows = (focus: SidebarFocusTarget) =>
    sidebarFocusRootRows(rows(focus), focus, focusWorld).map((row) => `${row.depth}:${row.key}`);

  test("a focused root folder lists its contents as the top level, without its own row", () => {
    expect(shownRows({ kind: "folder", folderId: "work" })).toEqual([
      "0:api",
      "0:folder:client",
      "1:app",
    ]);
  });

  test("a focused nested root folder rebases its children to depth 0", () => {
    expect(shownRows({ kind: "folder", folderId: "client" })).toEqual(["0:app"]);
  });

  test("a focused project inside folded folders keeps only that project's block", () => {
    expect(shownRows({ kind: "project", projectKey: "app" })).toEqual(["0:app"]);
  });

  test("a focused project folder lists its contents without its own row", () => {
    const projectRows = buildSidebarTreeRows({
      state: {
        ...EMPTY_SIDEBAR_FOLDER_STATE,
        sidebarFolders: {
          bugs: folder("bugs", null, { kind: "project", projectKey: "app" }),
          urgent: folder("urgent", "bugs", { kind: "project", projectKey: "app" }),
        },
        itemFolder: { w1: "bugs", w2: "urgent" },
      },
      scope: { kind: "project", projectKey: "app" },
      items: ["w0", "w1", "w2"],
      getKey: (item) => item,
      hideEmptyFolders: false,
    });
    expect(
      focusTreeRows(projectRows, "folder:bugs").map((row) => `${row.depth}:${row.key}`),
    ).toEqual(["0:w1", "0:folder:urgent", "1:w2"]);
  });

  test("top-level drops in a focused root folder land in that folder", () => {
    expect(sidebarFocusRootDropTop({ kind: "folder", folderId: "work" }, focusWorld)).toEqual({
      key: "folder:work",
      kind: "rootFolder",
      projectKey: null,
      section: null,
    });
    expect(sidebarFocusRootDropTop({ kind: "project", projectKey: "app" }, focusWorld)).toBeNull();
  });

  test("unfolding for focus never touches the stored collapse state", () => {
    rows({ kind: "folder", folderId: "client" });
    expect(state.collapsedFolders).toEqual({ work: true });
  });
});

describe("project block levels while focused", () => {
  test("an unfocused project steps its children in under its own row", () => {
    expect(sidebarProjectBlockLevels(null)).toEqual({
      showHeader: true,
      childLevel: 1,
      sectionLevel: 1,
      sectionItemLevel: 2,
    });
  });

  test("a focused project hides its row and lists its children at the top level", () => {
    expect(sidebarProjectBlockLevels({ kind: "project" })).toEqual({
      showHeader: false,
      childLevel: 0,
      sectionLevel: 0,
      sectionItemLevel: 1,
    });
  });

  test("a focused project folder lists its contents at the top level", () => {
    expect(sidebarProjectBlockLevels({ kind: "folder", folderId: "bugs" })).toMatchObject({
      showHeader: false,
      childLevel: 0,
    });
  });

  test("a focused section hides its heading and lists its workspaces at the top level", () => {
    expect(sidebarProjectBlockLevels({ kind: "section", section: "standing" })).toEqual({
      showHeader: false,
      childLevel: 0,
      sectionLevel: null,
      sectionItemLevel: 0,
    });
  });
});

describe("the row Focus button", () => {
  test("shows only on hover with a pointer", () => {
    expect(sidebarRowFocusVisibility({ isHovered: false, hoverUnavailable: false })).toEqual({
      button: false,
      hoverOnly: false,
    });
    expect(sidebarRowFocusVisibility({ isHovered: true, hoverUnavailable: false })).toEqual({
      button: true,
      hoverOnly: true,
    });
  });

  test("shows permanently where rows cannot be hovered, such as touch and compact layouts", () => {
    // Rows without a ⋮ menu keep their hover-only button off these layouts.
    expect(sidebarRowFocusVisibility({ isHovered: false, hoverUnavailable: true })).toEqual({
      button: true,
      hoverOnly: false,
    });
    expect(sidebarRowFocusVisibility({ isHovered: true, hoverUnavailable: true })).toEqual({
      button: true,
      hoverOnly: false,
    });
  });
});

describe("the breadcrumb's trailing actions", () => {
  const hidden = { isHovered: false, hasFocusWithin: false, hoverUnavailable: false };

  test("stay hidden with a pointer until hovered", () => {
    expect(sidebarBreadcrumbActionsVisible(hidden)).toBe(false);
    expect(sidebarBreadcrumbActionsVisible({ ...hidden, isHovered: true })).toBe(true);
  });

  test("show while keyboard focus is inside them, without hover", () => {
    expect(sidebarBreadcrumbActionsVisible({ ...hidden, hasFocusWithin: true })).toBe(true);
  });

  test("always show where rows cannot be hovered", () => {
    expect(sidebarBreadcrumbActionsVisible({ ...hidden, hoverUnavailable: true })).toBe(true);
  });
});
