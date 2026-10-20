import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import {
  describeCopies,
  groupDuplicateProfiles,
  isLegacyProfileCopy,
  profileDifferences,
} from "./profile-duplicates";

const profile = (overrides: Partial<AgentProfile> & { id: string; name: string }): AgentProfile =>
  ({
    provider: "codex",
    model: "gpt-6-astra",
    thinkingOptionId: "medium",
    ...overrides,
  }) as AgentProfile;

describe("groupDuplicateProfiles", () => {
  it("nests a legacy copy under the current profile with the same name", () => {
    const legacy = profile({
      id: "legacy-profile-abc",
      name: "Astra + Sol Workers",
      thinkingOptionId: "ultra",
    });
    const current = profile({ id: "primary-direct", name: "Astra + Sol Workers" });
    const other = profile({ id: "solo", name: "6.1 Sol" });
    const groups = groupDuplicateProfiles([legacy, current, other]);
    expect(groups.map((group) => group.primary.id)).toEqual(["primary-direct", "solo"]);
    expect(groups[0].copies).toEqual([{ profile: legacy, differences: ["reasoning"] }]);
    expect(groups[1].copies).toEqual([]);
  });

  it("matches names regardless of case and surrounding space", () => {
    const groups = groupDuplicateProfiles([
      profile({ id: "a", name: "Reviewer" }),
      profile({ id: "b", name: " reviewer " }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe("a");
  });
});

describe("profileDifferences", () => {
  it("names each differing setting once", () => {
    const base = profile({ id: "a", name: "A", workerProfileId: "w", maxWorkers: 2 });
    const copy = profile({
      id: "b",
      name: "A",
      model: "other",
      workerProfileId: "w",
      maxWorkers: 8,
      instructions: "  ",
    });
    expect(profileDifferences(base, copy)).toEqual(["model", "workers"]);
  });
});

describe("isLegacyProfileCopy", () => {
  it("recognizes bare and namespaced legacy ids", () => {
    expect(isLegacyProfileCopy({ id: "legacy-profile-1" })).toBe(true);
    expect(isLegacyProfileCopy({ id: "shared-profile/codex/legacy-profile-1" })).toBe(true);
    expect(isLegacyProfileCopy({ id: "shared-profile/codex/primary" })).toBe(false);
  });
});

describe("describeCopies", () => {
  it("summarizes count and differences", () => {
    const copy = { profile: profile({ id: "b", name: "A" }), differences: ["reasoning"] };
    expect(describeCopies([copy])).toBe("1 older copy · differs in reasoning");
    expect(describeCopies([copy, { ...copy, differences: [] }])).toBe(
      "2 older copies · differs in reasoning",
    );
  });
});
