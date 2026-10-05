import type { AgentSessionConfig } from "../../agent/agent-sdk-types.js";
import type { SkillPolicy, SkillSnapshot } from "@getpaseo/protocol/skill-library";
import { inventorySkills, readPackage, SkillLibraryError } from "./inventory.js";

export function isRestricted(policy: SkillPolicy | undefined): boolean {
  if (!policy) return false;
  return policy.mode !== "inherit" || policy.include.length > 0 || policy.exclude.length > 0;
}

export async function captureSkillPolicy(
  config: AgentSessionConfig,
  provider: string,
  home?: string,
  nativeDefaults?: string[],
): Promise<void> {
  const launch = config.profileLaunch;
  const policy = launch?.profile.skillPolicy;
  if (!launch || !policy || !isRestricted(policy)) return;
  if (provider !== "claude" && provider !== "codex")
    throw new SkillLibraryError(
      "unsupported_policy",
      "This provider has no verified session skill filter. Use inherited defaults or select a supported Claude or Codex provider.",
    );
  const inventory = await inventorySkills({ home, cwd: config.cwd });
  const candidates = inventory.skills.filter((skill) => skill.providers.includes(provider));
  let include: string[] = [];
  if (policy.mode === "selected") include = policy.skills;
  if (policy.mode === "inherit") include = policy.include;
  for (const identity of include) {
    if (!candidates.some((skill) => skill.identity === identity))
      throw new SkillLibraryError(
        "missing_skill",
        `Selected skill is unavailable in this environment: ${identity}`,
      );
  }
  validateNativeDefaults(nativeDefaults, candidates);
  const selected = candidates.filter((skill) => {
    if (policy.mode === "none") return false;
    if (policy.mode === "selected") return policy.skills.includes(skill.identity);
    const enabledByDefault = nativeDefaults ? nativeDefaults.includes(skill.name) : true;
    return (
      (enabledByDefault || policy.include.includes(skill.identity)) &&
      !policy.exclude.includes(skill.identity)
    );
  });
  const snapshot: SkillSnapshot = { capturedAt: new Date().toISOString(), provider, skills: [] };
  for (const skill of selected) {
    if (!skill.sha256 || skill.issues.length || (skill.owner === "plugin" && provider !== "codex"))
      throw new SkillLibraryError(
        "unverified_skill",
        `Cannot verify a unique provider selector for ${skill.name}`,
      );
    const conflicting = candidates.some(
      (other) =>
        other.name === skill.name &&
        (other.identity !== skill.identity || other.sha256 !== skill.sha256),
    );
    if (conflicting)
      throw new SkillLibraryError(
        "ambiguous_skill",
        `Multiple packages use the provider selector ${skill.name}`,
      );
    snapshot.skills.push({
      identity: skill.identity,
      name: skill.name,
      path: skill.resolvedPath ?? skill.path,
      sha256: skill.sha256,
    });
  }
  const failures = inventory.roots.filter((root) => root.status === "error");
  if (failures.length)
    throw new SkillLibraryError(
      "incomplete_inventory",
      "Skill discovery is incomplete; resolve inventory errors before launching a restricted profile",
    );
  launch.skillSnapshot = snapshot;
}

export async function verifySkillSnapshot(
  config: AgentSessionConfig,
): Promise<string[] | undefined> {
  const launch = config.profileLaunch;
  if (!isRestricted(launch?.profile.skillPolicy)) return undefined;
  const snapshot = launch?.skillSnapshot;
  if (!snapshot)
    throw new SkillLibraryError(
      "missing_snapshot",
      "This restricted task has no verified skill snapshot. Recreate it with the reviewed profile.",
    );
  for (const skill of snapshot.skills) {
    if ((await readPackage(skill.path)).hash !== skill.sha256)
      throw new SkillLibraryError(
        "skill_changed",
        `Skill ${skill.name} changed after launch. Restore its recorded version or recreate this task.`,
      );
  }
  return [...new Set(snapshot.skills.map((skill) => skill.name))];
}

function validateNativeDefaults(
  defaults: string[] | undefined,
  candidates: Array<{ name: string }>,
): void {
  for (const name of defaults ?? []) {
    if (!candidates.some((skill) => skill.name === name))
      throw new SkillLibraryError(
        "unverified_skill",
        `Provider skill ${name} has no inspectable package. Use selected-only skills or resolve its source before applying exclusions.`,
      );
  }
}
