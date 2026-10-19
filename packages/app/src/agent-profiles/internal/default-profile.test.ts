import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { defaultProfile, ensureDefaultProfile } from "./default-profile";

const first: AgentProfile = { id: "first", name: "First", provider: "codex" };
const second: AgentProfile = { id: "second", name: "Second", provider: "claude" };

describe("default configuration", () => {
  it("waits for configurations, then selects the first available", () => {
    expect(defaultProfile(null)).toBeUndefined();
    expect(defaultProfile([])).toBeUndefined();
    expect(defaultProfile([first, second])).toBe(first);
  });
  it("preserves an explicit default regardless of list order", () => {
    const selected = { ...second, isDefault: true };
    const profiles = [first, selected];
    expect(defaultProfile(profiles)).toBe(selected);
    expect(ensureDefaultProfile(profiles)).toBe(profiles);
  });
  it("replaces a removed default and persists the replacement on save", () => {
    expect(defaultProfile([second])).toBe(second);
    expect(ensureDefaultProfile([second])).toEqual([{ ...second, isDefault: true }]);
    expect(second.isDefault).toBeUndefined();
  });
  it("handles first creation and removal of the last configuration", () => {
    expect(ensureDefaultProfile([first])).toEqual([{ ...first, isDefault: true }]);
    expect(ensureDefaultProfile([])).toEqual([]);
  });
});

it("prefers the account default and falls back when it was removed or excluded", () => {
  const profiles = [
    { id: "one", name: "One", provider: "codex", isDefault: true },
    { id: "two", name: "Two", provider: "codex" },
  ];
  expect(defaultProfile(profiles, "two")?.id).toBe("two");
  expect(defaultProfile(profiles, "deleted")?.id).toBe("one");
  expect(defaultProfile([], "two")).toBeUndefined();
});
