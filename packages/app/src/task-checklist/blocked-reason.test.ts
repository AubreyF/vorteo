import { expect, test } from "vitest";
import { blockedTaskReason } from "./blocked-reason";

test("blocked tags explain the recorded blocker without substituting the active-form label", () => {
  expect(
    blockedTaskReason({
      text: "Verify Dev",
      completed: false,
      status: "blocked",
      activeForm: "Waiting",
      description: "  Dev is offline. Recheck when it reconnects.  ",
      blockedBy: ["setup"],
    }),
  ).toBe("Dev is offline. Recheck when it reconnects.");
});

test("legacy tasks explain prerequisite work without exposing dependency IDs", () => {
  expect(
    blockedTaskReason({
      text: "Verify",
      completed: false,
      blockedBy: ["4f68a45e-abc1-4d12-8911-28eae23e4331", "internal-install-task"],
    }),
  ).toBe(
    "Waiting for 2 prerequisite tasks to finish. The agent has not recorded a more specific reason.",
  );
  expect(blockedTaskReason({ text: "Verify", completed: false, description: " " })).toContain(
    "without recording a reason",
  );
});
