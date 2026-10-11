import type { AgentProfile } from "@getpaseo/protocol/messages";

/** Resolve old lists without a default without writing configuration during render. */
export function defaultProfile(
  profiles: readonly AgentProfile[] | null | undefined,
  preferredId?: string,
) {
  return (
    profiles?.find((profile) => profile.id === preferredId) ??
    profiles?.find((profile) => profile.isDefault === true) ??
    profiles?.[0]
  );
}

export function ensureDefaultProfile(profiles: AgentProfile[]): AgentProfile[] {
  if (!profiles.length || profiles.some((profile) => profile.isDefault === true)) return profiles;
  return profiles.map((profile, index) =>
    index === 0 ? { ...profile, isDefault: true } : profile,
  );
}
