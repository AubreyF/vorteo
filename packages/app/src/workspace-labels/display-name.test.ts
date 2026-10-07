import { expect, test } from "vitest";
import { workspaceLabelDisplayName } from "./display-name";

test("custom names cannot imply workspace lifecycle behavior", () => {
  expect(workspaceLabelDisplayName("Protected")).toBe("Protected (custom)");
  expect(workspaceLabelDisplayName("STANDING")).toBe("STANDING (custom)");
  expect(workspaceLabelDisplayName("Scheduled")).toBe("Scheduled (custom)");
  expect(workspaceLabelDisplayName("Release review")).toBe("Release review");
});
