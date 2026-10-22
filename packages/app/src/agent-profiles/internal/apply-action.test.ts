import { describe, expect, it } from "vitest";
import { agentProfileApplyAction } from "./apply-action";

describe("agentProfileApplyAction", () => {
  it("applies profiles to drafts regardless of host features", () => {
    expect(
      agentProfileApplyAction({ target: "draft", supportsLaunch: true, supportsSwitch: true }),
    ).toBe("draft");
  });

  it("reconfigures the current provider on hosts without launch support", () => {
    expect(
      agentProfileApplyAction({ target: "agent", supportsLaunch: false, supportsSwitch: true }),
    ).toBe("config");
  });

  it("starts a successor task when the host cannot switch in place", () => {
    expect(
      agentProfileApplyAction({ target: "agent", supportsLaunch: true, supportsSwitch: false }),
    ).toBe("successor");
  });

  it("switches the existing thread when the host advertises in-place switching", () => {
    expect(
      agentProfileApplyAction({ target: "agent", supportsLaunch: true, supportsSwitch: true }),
    ).toBe("switch");
  });
});
