import type { AgentProfile } from "@getpaseo/protocol/messages";

/**
 * Profiles that share a name with another profile of the same provider. Older
 * installations migrated each saved profile into a copy whose id starts with
 * `legacy-profile-`; those copies stay because older launches and workers still
 * reference them, but listing them as peers made the profile list look doubled.
 */
export interface ProfileGroup<T extends AgentProfile> {
  primary: T;
  copies: Array<{ profile: T; differences: string[] }>;
}

const LEGACY_PREFIX = "legacy-profile-";

const COMPARED_FIELDS: ReadonlyArray<{ label: string; read: (profile: AgentProfile) => unknown }> =
  [
    { label: "model", read: (profile) => profile.model ?? null },
    { label: "permissions", read: (profile) => profile.modeId ?? null },
    { label: "reasoning", read: (profile) => profile.thinkingOptionId ?? null },
    { label: "instructions", read: (profile) => profile.instructions?.trim() || null },
    {
      label: "workers",
      read: (profile) => [profile.workerProfileId || null, profile.maxWorkers ?? null],
    },
    { label: "features", read: (profile) => profile.featureValues ?? {} },
  ];

export function isLegacyProfileCopy(profile: Pick<AgentProfile, "id">): boolean {
  return profile.id.startsWith(LEGACY_PREFIX) || profile.id.includes(`/${LEGACY_PREFIX}`);
}

/** Names of the settings in which `copy` differs from `primary`. */
export function profileDifferences(primary: AgentProfile, copy: AgentProfile): string[] {
  return COMPARED_FIELDS.filter(
    (field) => JSON.stringify(field.read(primary)) !== JSON.stringify(field.read(copy)),
  ).map((field) => field.label);
}

/**
 * Groups profiles by name, keeping list order by each group's first member.
 * The primary is the first non-legacy profile in the group, or its first member.
 */
export function groupDuplicateProfiles<T extends AgentProfile>(
  profiles: readonly T[],
): ProfileGroup<T>[] {
  const byName = new Map<string, T[]>();
  for (const profile of profiles) {
    const key = profile.name.trim().toLowerCase();
    const members = byName.get(key);
    if (members) members.push(profile);
    else byName.set(key, [profile]);
  }
  return [...byName.values()].map((members) => {
    const primary = members.find((member) => !isLegacyProfileCopy(member)) ?? members[0];
    return {
      primary,
      copies: members
        .filter((member) => member !== primary)
        .map((profile) => ({ profile, differences: profileDifferences(primary, profile) })),
    };
  });
}

/** One-line description of a group's copies, such as "1 older copy · differs in reasoning". */
export function describeCopies(copies: ProfileGroup<AgentProfile>["copies"]): string {
  const count = `${copies.length} older ${copies.length === 1 ? "copy" : "copies"}`;
  const differences = [...new Set(copies.flatMap((copy) => copy.differences))];
  return differences.length ? `${count} · differs in ${differences.join(", ")}` : `${count}`;
}
