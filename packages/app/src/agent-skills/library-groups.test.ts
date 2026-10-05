import { describe, expect, it } from "vitest";
import type { SkillInstallation } from "@getpaseo/protocol/skill-library";
import { groupSkillLocations } from "./library-groups";

const canonical: SkillInstallation = {
  id: "canonical",
  identity: "github:example/skills/example",
  name: "example",
  description: "Example",
  path: "/home/.agents/skills/example",
  resolvedPath: "/home/.agents/skills/example",
  owner: "personal",
  providers: ["codex"],
  sha256: "hash",
  files: [],
  issues: [],
  source: null,
  managed: true,
  discovery: "filesystem",
};
const alias: SkillInstallation = {
  ...canonical,
  id: "alias",
  path: "/home/.claude/skills/example",
  providers: ["claude"],
};

describe("skill discovery groups", () => {
  it("shows one package with both providers and prefers its canonical path", () => {
    const groups = groupSkillLocations([alias, canonical]);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary).toBe(canonical);
    expect(groups[0].providers).toEqual(["claude", "codex"]);
    expect(groups[0].locations).toEqual([alias, canonical]);
  });
  it("keeps identical copies at different physical paths separate", () => {
    expect(groupSkillLocations([canonical, { ...alias, resolvedPath: alias.path }])).toHaveLength(
      2,
    );
  });
  it.each([
    { sha256: "different" },
    { resolvedPath: null },
    { sha256: null },
    { issues: ["Inspection incomplete"] },
    { identity: "different-source" },
    { owner: "plugin" as const },
  ])("keeps conflicting or incomplete observations visible: %j", (difference) => {
    expect(groupSkillLocations([canonical, { ...alias, ...difference }])).toHaveLength(2);
  });
});
