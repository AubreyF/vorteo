import { expect, test } from "vitest";
import { checklistFormMutation, openChecklistForm, updateChecklistForm } from "./form-model";

test("new tasks stay pending and editing carries the original task for conflict detection", () => {
  let form = openChecklistForm(null);
  form = updateChecklistForm(form, { field: "text", value: "  Build API  " });
  form = updateChecklistForm(form, { field: "dependency", value: "design" });
  expect(checklistFormMutation(form)).toEqual({
    operation: "create",
    text: "Build API",
    description: "",
    owner: "",
    activeForm: "",
    blockedBy: ["design"],
  });
  const original = {
    id: "a",
    source: "vorteo" as const,
    text: "API",
    completed: false,
    description: "Acceptance",
    status: "pending" as const,
    blockedBy: ["design"],
  };
  form = openChecklistForm(original);
  form = updateChecklistForm(form, { field: "dependency", value: "design" });
  form = updateChecklistForm(form, { field: "status", value: "completed" });
  expect(checklistFormMutation(form)).toEqual({
    operation: "update",
    id: "a",
    expectedTask: original,
    text: "API",
    description: "Acceptance",
    status: "completed",
    owner: "",
    activeForm: "",
    blockedBy: [],
  });
  expect(original.blockedBy).toEqual(["design"]);
});
