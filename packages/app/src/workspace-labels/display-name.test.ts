import { expect, test } from "vitest";
import { workspaceLabelDisplayName, isBuiltInWorkspaceLabel } from "./display-name";

test("built-in names stay out of the custom-label namespace without display suffixes", () => {
  for (const name of ["Protected", " STANDING ", "scheduled"]) {
    expect(isBuiltInWorkspaceLabel(name)).toBe(true);
    expect(workspaceLabelDisplayName(name)).toBe(name);
  }
  expect(isBuiltInWorkspaceLabel("Release review")).toBe(false);
});
