import type { SkillInstallation, SkillPolicy } from "@getpaseo/protocol/skill-library";

export function profileSkillChoices(
  skills: readonly SkillInstallation[],
  providerType: string,
): SkillInstallation[] {
  const available = skills.filter((skill) => skill.providers.includes(providerType));
  return [...new Map(available.map((skill) => [skill.identity, skill])).values()];
}

export function savedSkillIdentities(policy: SkillPolicy): string[] {
  if (policy.mode === "selected") return policy.skills;
  if (policy.mode === "inherit") return [...policy.include, ...policy.exclude];
  return [];
}
