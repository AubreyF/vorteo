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

test("legacy tasks show dependencies or honestly explain that no reason was recorded", () => {
  expect(
    blockedTaskReason({ text: "Verify", completed: false, blockedBy: ["setup", "install"] }),
  ).toContain("setup, install");
  expect(blockedTaskReason({ text: "Verify", completed: false, description: " " })).toContain(
    "without recording a reason",
  );
});
