import { describe, expect, test } from "vitest";
import { SIDEBAR_INDENT_UNIT } from "@/components/sidebar/indent";
import {
  resolveSidebarDrop,
  type SidebarDraggedItem,
  type SidebarDropInput,
  type SidebarDropRow,
} from "./resolve";

const U = SIDEBAR_INDENT_UNIT;

function row(
  key: string,
  kind: SidebarDropRow["kind"],
  depth: number,
  options: Partial<SidebarDropRow> = {},
): SidebarDropRow {
  const containers = ["rootFolder", "project", "projectFolder", "section"];
  return {
    key,
    kind,
    depth,
    expanded: containers.includes(kind),
    projectKey: kind === "project" ? key : null,
    section: null,
    ...options,
  };
}

function project(key: string): SidebarDraggedItem {
  return { key, kind: "project", projectKey: key, section: null };
}

function workspace(key: string, projectKey: string): SidebarDraggedItem {
  return { key, kind: "workspace", projectKey, section: null };
}

function resolve(input: Partial<SidebarDropInput> & Pick<SidebarDropInput, "rows" | "dragged">) {
  return resolveSidebarDrop({
    top: null,
    overKey: input.dragged.key,
    overFraction: 0.5,
    pointerX: 0,
    rowContentStartX: 0,
    previousDepth: null,
    ...input,
  });
}

// alpha (expanded) > a1, a2; beta (expanded) > b1; gamma at the end.
const projects: SidebarDropRow[] = [
  row("alpha", "project", 0),
  row("a1", "workspace", 1, { projectKey: "alpha" }),
  row("a2", "workspace", 1, { projectKey: "alpha" }),
  row("beta", "project", 0),
  row("b1", "workspace", 1, { projectKey: "beta" }),
  row("gamma", "project", 0, { expanded: false }),
];

describe("projects and root folders", () => {
  test("a project dropped in the gap after an expanded project's last workspace stays at root", () => {
    const placement = resolve({
      rows: projects,
      dragged: project("gamma"),
      overKey: "a2",
      overFraction: 0.9,
      // Far right: as deep as the pointer could ask for.
      pointerX: 6 * U,
    });
    expect(placement).toMatchObject({
      mode: "between",
      container: null,
      depth: 0,
      beforeKey: "beta",
    });
  });

  test("a project between another project's workspaces snaps to the nearest root position", () => {
    const placement = resolve({
      rows: projects,
      dragged: project("gamma"),
      overKey: "a1",
      overFraction: 0.2,
      pointerX: 3 * U,
    });
    expect(placement).toMatchObject({ container: null, depth: 0, beforeKey: "alpha" });
  });

  test("a project dropped on another project's middle zone is not nested", () => {
    const placement = resolve({
      rows: projects,
      dragged: project("gamma"),
      overKey: "beta",
      overFraction: 0.5,
      pointerX: 4 * U,
    });
    expect(placement?.mode).toBe("between");
    expect(placement?.container).toBeNull();
    expect(placement?.depth).toBe(0);
  });

  test("a root folder accepts a project into its middle zone", () => {
    const rows = [
      row("folder:work", "rootFolder", 0, { expanded: false }),
      row("alpha", "project", 0, { expanded: false }),
    ];
    expect(
      resolve({ rows, dragged: project("alpha"), overKey: "folder:work", overFraction: 0.5 }),
    ).toEqual({
      mode: "into",
      container: "folder:work",
      index: 0,
      depth: 1,
      beforeKey: null,
      afterKey: null,
      lineBeforeKey: null,
    });
  });

  test("a root folder's top and bottom quarters place beside it", () => {
    const rows = [
      row("folder:work", "rootFolder", 0, { expanded: false }),
      row("alpha", "project", 0, { expanded: false }),
      row("beta", "project", 0, { expanded: false }),
    ];
    const base = { rows, dragged: project("beta"), overKey: "folder:work" };
    expect(resolve({ ...base, overFraction: 0.1 })).toMatchObject({
      mode: "between",
      container: null,
      beforeKey: "folder:work",
    });
    expect(resolve({ ...base, overFraction: 0.9 })).toMatchObject({
      mode: "between",
      container: null,
      beforeKey: "alpha",
    });
  });

  test("horizontal offset leaves a root folder after its last project", () => {
    const rows = [
      row("folder:work", "rootFolder", 0),
      row("alpha", "project", 1, { expanded: false }),
      row("beta", "project", 0, { expanded: false }),
      row("gamma", "project", 0, { expanded: false }),
    ];
    const inside = resolve({
      rows,
      dragged: project("gamma"),
      overKey: "alpha",
      overFraction: 0.9,
      pointerX: 1 * U,
    });
    expect(inside).toMatchObject({ container: "folder:work", depth: 1, beforeKey: null });
    const outside = resolve({
      rows,
      dragged: project("gamma"),
      overKey: "alpha",
      overFraction: 0.9,
      pointerX: 0,
    });
    expect(outside).toMatchObject({ container: null, depth: 0, beforeKey: "beta" });
  });

  test("a folder never lands inside itself", () => {
    const rows = [
      row("folder:work", "rootFolder", 0),
      row("folder:inner", "rootFolder", 1, { expanded: false }),
      row("alpha", "project", 0, { expanded: false }),
    ];
    const placement = resolve({
      rows,
      dragged: { key: "folder:work", kind: "rootFolder", projectKey: null, section: null },
      overKey: "folder:inner",
      overFraction: 0.5,
    });
    // Its own rows are removed while it is dragged, so the pointer is over its own slot.
    expect(placement).toBeNull();
  });
});

describe("dropping in place", () => {
  test("a row released over its own slot at its own depth does not move", () => {
    expect(resolve({ rows: projects, dragged: project("beta"), overKey: "beta" })).toBeNull();
  });

  test("a row released over its own slot further left outdents", () => {
    const rows = [
      row("folder:work", "rootFolder", 0),
      row("alpha", "project", 1, { expanded: false }),
    ];
    expect(
      resolve({ rows, dragged: project("alpha"), overKey: "alpha", pointerX: 0 }),
    ).toMatchObject({ container: null, depth: 0, afterKey: "folder:work" });
  });
});

describe("workspaces", () => {
  test("a workspace between another project's rows stays in its own project", () => {
    expect(
      resolve({
        rows: projects,
        dragged: workspace("a1", "alpha"),
        overKey: "b1",
        overFraction: 0.9,
        pointerX: 1 * U,
      }),
    ).toBeNull();
  });

  test("a workspace dropped on another project's header moves into that project", () => {
    for (const overFraction of [0.5, 0.9]) {
      expect(
        resolve({
          rows: projects,
          dragged: workspace("a1", "alpha"),
          overKey: "beta",
          overFraction,
        }),
      ).toMatchObject({ mode: "into", container: "beta" });
    }
  });

  test("the top quarter of the next project's header ends the workspace's own project", () => {
    expect(
      resolve({
        rows: projects,
        dragged: workspace("a1", "alpha"),
        overKey: "beta",
        overFraction: 0.1,
        pointerX: 1 * U,
      }),
    ).toMatchObject({ mode: "between", container: "alpha", depth: 1, beforeKey: null });
  });

  test("a workspace reorders inside its own project", () => {
    expect(
      resolve({
        rows: projects,
        dragged: workspace("a2", "alpha"),
        overKey: "a1",
        overFraction: 0.2,
        pointerX: 1 * U,
      }),
    ).toMatchObject({ mode: "between", container: "alpha", index: 0, depth: 1, beforeKey: "a1" });
  });

  // alpha > folder bugs > w1; then w2 directly in alpha.
  const folders: SidebarDropRow[] = [
    row("alpha", "project", 0),
    row("folder:bugs", "projectFolder", 1, { projectKey: "alpha" }),
    row("w1", "workspace", 2, { projectKey: "alpha" }),
    row("w2", "workspace", 1, { projectKey: "alpha" }),
    row("w3", "workspace", 1, { projectKey: "alpha" }),
  ];

  test("dragging left at a project-folder boundary outdents", () => {
    const base = {
      rows: folders,
      dragged: workspace("w3", "alpha"),
      overKey: "w1",
      overFraction: 0.9,
    };
    expect(resolve({ ...base, pointerX: 2 * U })).toMatchObject({
      container: "folder:bugs",
      depth: 2,
      index: 1,
      beforeKey: null,
      lineBeforeKey: "w2",
    });
    expect(resolve({ ...base, pointerX: 1 * U })).toMatchObject({
      container: "alpha",
      depth: 1,
      index: 1,
      beforeKey: "w2",
    });
  });

  test("depth holds near a boundary until the pointer clears the hysteresis band", () => {
    const base = {
      rows: folders,
      dragged: workspace("w3", "alpha"),
      overKey: "w1",
      overFraction: 0.9,
    };
    const justPastHalf = 1.6 * U;
    expect(resolve({ ...base, pointerX: justPastHalf, previousDepth: 1 })?.depth).toBe(1);
    expect(resolve({ ...base, pointerX: justPastHalf, previousDepth: null })?.depth).toBe(2);
    expect(resolve({ ...base, pointerX: 1.8 * U, previousDepth: 1 })?.depth).toBe(2);
  });

  test("a project folder accepts a workspace into its middle zone", () => {
    expect(
      resolve({
        rows: folders,
        dragged: workspace("w3", "alpha"),
        overKey: "folder:bugs",
        overFraction: 0.5,
      }),
    ).toMatchObject({ mode: "into", container: "folder:bugs", index: 1, depth: 2 });
  });

  test("Standing workspaces reorder only inside Standing", () => {
    const rows: SidebarDropRow[] = [
      row("w1", "workspace", 0, { projectKey: "alpha" }),
      row("w2", "workspace", 0, { projectKey: "alpha" }),
    ];
    const top = {
      key: "standing:alpha",
      kind: "section" as const,
      projectKey: "alpha",
      section: "standing" as const,
    };
    const standing = { ...workspace("s1", "alpha"), section: "standing" as const };
    const placed = resolve({
      rows: [...rows, row("s1", "workspace", 0, { projectKey: "alpha", section: "standing" })],
      top,
      dragged: standing,
      overKey: "w1",
      overFraction: 0.1,
    });
    expect(placed).toMatchObject({ container: "standing:alpha", beforeKey: "w1" });
    const work = workspace("w2", "alpha");
    expect(resolve({ rows, top, dragged: work, overKey: "w1", overFraction: 0.1 })).toBeNull();
  });

  test("a focused folder is the top container for its rows", () => {
    const top = {
      key: "folder:bugs",
      kind: "projectFolder" as const,
      projectKey: "alpha",
      section: null,
    };
    const rows = [
      row("w1", "workspace", 0, { projectKey: "alpha" }),
      row("w2", "workspace", 0, { projectKey: "alpha" }),
    ];
    expect(
      resolve({ rows, top, dragged: workspace("w2", "alpha"), overKey: "w1", overFraction: 0.1 }),
    ).toMatchObject({ container: "folder:bugs", index: 0, beforeKey: "w1" });
  });
});

describe("focused lists", () => {
  // Focused on root folder "work": its contents are the top level, rebased to depth 0.
  const focused: SidebarDropRow[] = [
    row("alpha", "project", 0, { expanded: false }),
    row("folder:client", "rootFolder", 0),
    row("beta", "project", 1, { expanded: false }),
  ];
  const top = { key: "folder:work", kind: "rootFolder", projectKey: null, section: null } as const;

  test("a depth-0 drop lands in the focused folder", () => {
    const placement = resolve({
      rows: focused,
      top,
      dragged: project("beta"),
      overKey: "alpha",
      overFraction: 0.1,
    });
    expect(placement).toMatchObject({
      mode: "between",
      container: "folder:work",
      depth: 0,
      beforeKey: "alpha",
    });
  });

  test("one indent unit to the right nests inside a focused child folder", () => {
    const placement = resolve({
      rows: focused,
      top,
      dragged: project("alpha"),
      overKey: "beta",
      overFraction: 0.9,
      pointerX: U,
    });
    expect(placement).toMatchObject({ container: "folder:client", depth: 1 });
  });
});
