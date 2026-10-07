import { expect, test } from "vitest";
import { workspaceLabelDisplayName, isBuiltInWorkspaceLabel } from "./display-name";

test("existing custom labels with built-in names remain distinguishable", () => {
  for (const name of ["Protected", " STANDING ", "scheduled"]) {
    expect(isBuiltInWorkspaceLabel(name)).toBe(true);
    expect(workspaceLabelDisplayName(name)).toBe(`${name} (custom)`);
  }
  expect(isBuiltInWorkspaceLabel("Release review")).toBe(false);
});
