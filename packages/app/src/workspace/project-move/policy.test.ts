import { expect, test } from "vitest";
import { projectMoveBlockedReason } from "./policy";
test("protected moves explain the existing action; ordinary moves remain available", () => {
  expect(projectMoveBlockedReason({ protected: true })).toContain(
    "Turn off protection in Workspace actions",
  );
  expect(projectMoveBlockedReason({ protected: false })).toBeNull();
});
