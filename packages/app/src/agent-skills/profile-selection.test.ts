import { expect, it } from "vitest";
import type { SkillInstallation } from "@getpaseo/protocol/skill-library";
import { profileSkillChoices } from "./profile-selection";

const skill: SkillInstallation = {
  id: "claude-review",
  identity: "review",
  name: "Review",
  description: "Review changes",
  path: "/skills/review",
  resolvedPath: "/skills/review",
  owner: "personal",
  providers: ["claude"],
  sha256: "hash",
  files: [],
  issues: [],
  source: null,
  managed: false,
  discovery: "filesystem",
};

it("shows only skills discovered for the profile's provider, before deduplicating identities", () => {
  const codexCopy = { ...skill, id: "codex-review", providers: ["codex"] };
  const codexOnly = { ...codexCopy, identity: "codex-only", name: "Codex only" };
  const system = { ...skill, id: "required", identity: "required", providers: [] };
  expect(profileSkillChoices([skill, codexCopy, codexOnly, system], "claude")).toEqual([skill]);
  expect(profileSkillChoices([skill, codexCopy, codexOnly, system], "codex")).toEqual([
    codexCopy,
    codexOnly,
  ]);
});
