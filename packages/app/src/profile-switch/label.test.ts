import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { profileSwitchEndpointLabel } from "./label";

const entries: ProviderSnapshotEntry[] = [
  { provider: "claude-account-1", label: "Claude 1", enabled: true, status: "ready" },
];

describe("profileSwitchEndpointLabel", () => {
  it("shows the account label and model", () => {
    expect(
      profileSwitchEndpointLabel(
        { provider: "claude-account-1", model: "claude-opus-4-7" },
        entries,
      ),
    ).toBe("Claude 1 · claude-opus-4-7");
  });

  it("falls back to the provider id and omits a missing model", () => {
    expect(profileSwitchEndpointLabel({ provider: "codex-account-2", model: null }, entries)).toBe(
      "codex-account-2",
    );
  });
});
