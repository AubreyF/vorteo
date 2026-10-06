import { describe, expect, it } from "vitest";
import { isConnectionToast } from "./connection-toast";

describe("connection toast presentation", () => {
  it.each([
    "Transport closed (code 1006)",
    "Transport closed",
    "Transport not connected",
    "Transport not connected (status: connecting)",
  ])("uses the quiet connection chip for %s", (content) => {
    expect(isConnectionToast({ content })).toBe(true);
  });

  it("recognizes the persistent reconnect notice independently of its translation", () => {
    expect(
      isConnectionToast({
        content: "Reconnexion",
        testID: "agent-reconnecting-toast",
      }),
    ).toBe(true);
    expect(
      isConnectionToast({
        content: "Reconnexion",
        testID: "agent-reconnecting-toast",
      }),
    ).toBe(true);
  });

  it.each([
    "Permission denied",
    "Could not send message",
    "Transport closed: authentication rejected",
    "Provider unavailable",
    null,
  ])("preserves unrelated errors: %s", (content) => {
    expect(isConnectionToast({ content })).toBe(false);
  });
});
