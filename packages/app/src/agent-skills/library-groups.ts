import type { SkillInstallation } from "@getpaseo/protocol/skill-library";

export interface SkillGroup {
  id: string;
  primary: SkillInstallation;
  locations: SkillInstallation[];
  providers: string[];
}

export function groupSkillLocations(skills: SkillInstallation[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const skill of skills) {
    const key =
      skill.resolvedPath && skill.sha256 && skill.issues.length === 0
        ? JSON.stringify([skill.resolvedPath, skill.sha256, skill.owner, skill.identity])
        : skill.id;
    const group = groups.get(key);
    if (group) {
      group.locations.push(skill);
      group.providers = [...new Set([...group.providers, ...skill.providers])].sort();
      if (skill.path === skill.resolvedPath) group.primary = skill;
    } else {
      groups.set(key, {
        id: key,
        primary: skill,
        locations: [skill],
        providers: [...skill.providers].sort(),
      });
    }
  }
  return [...groups.values()];
}

export function findSkillLocations(
  groups: SkillGroup[],
  skill: SkillInstallation,
): SkillInstallation[] {
  return (
    groups.find((group) => group.locations.some((location) => location.id === skill.id))
      ?.locations ?? [skill]
  );
}
