import { beforeEach, describe, expect, test } from "vitest";
import { emptySidebarState } from "@getpaseo/protocol/sidebar-state";
import { applyLocalSidebar, readLocalSidebar } from "@/sidebar-state/local";
import { placeSidebarEntry } from "./actions";

beforeEach(() => applyLocalSidebar(emptySidebarState()));

describe("placing current sidebar items", () => {
  test("reorders newly listed workspaces before a saved order exists", () => {
    placeSidebarEntry({
      scope: { kind: "project", projectKey: "project" },
      entry: "first",
      targetFolderId: null,
      before: null,
      after: "second",
      keys: ["first", "second"],
    });
    expect(readLocalSidebar().workspaceOrderByProject.project).toEqual(["second", "first"]);
  });

  test("keeps stored siblings hidden by a filter when placing newly listed items", () => {
    applyLocalSidebar({
      ...emptySidebarState(),
      workspaceOrderByProject: { project: ["hidden", "first"] },
    });
    placeSidebarEntry({
      scope: { kind: "project", projectKey: "project" },
      entry: "first",
      targetFolderId: null,
      before: null,
      after: "second",
      keys: ["first", "second"],
    });
    expect(readLocalSidebar().workspaceOrderByProject.project).toEqual([
      "hidden",
      "second",
      "first",
    ]);
  });
});
