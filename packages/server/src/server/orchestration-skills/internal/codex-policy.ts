import path from "node:path";
import type { SkillSnapshot } from "@getpaseo/protocol/skill-library";
import { SkillLibraryError } from "./inventory.js";

export interface NativeSkill {
  name: string;
  path: string;
}
export function codexSkillFilter(snapshot: SkillSnapshot, catalog: NativeSkill[]) {
  const paths = new Set(snapshot.skills.map((skill) => path.join(skill.path, "SKILL.md")));
  for (const skill of snapshot.skills) {
    if (!catalog.some((entry) => entry.path === path.join(skill.path, "SKILL.md")))
      throw new SkillLibraryError(
        "undiscovered_skill",
        `Provider did not discover selected skill ${skill.name}`,
      );
  }
  return catalog.map((entry) => ({ path: entry.path, enabled: paths.has(entry.path) }));
}
