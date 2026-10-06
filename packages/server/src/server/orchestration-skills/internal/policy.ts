import type { AgentSessionConfig } from "../../agent/agent-sdk-types.js";
import type {
  SkillPolicy,
  SkillSnapshot,
  InstallationSkill,
  SkillInstallation,
} from "@getpaseo/protocol/skill-library";
import { inventorySkills, readPackage, SkillLibraryError } from "./inventory.js";

export function isRestricted(policy: SkillPolicy | undefined): boolean {
  if (!policy) return false;
  return policy.mode !== "inherit" || policy.include.length > 0 || policy.exclude.length > 0;
}

interface SkillCaptureOptions {
  home?: string;
  nativeDefaults?: string[] | (() => Promise<string[]>);
  installation?: {
    definitions: readonly InstallationSkill[];
    excludedIdentities: readonly string[];
  };
}
const INHERITED_SKILLS: SkillPolicy = { mode: "inherit", include: [], exclude: [] };

export function sessionSkillSnapshot(config: AgentSessionConfig): SkillSnapshot | undefined {
  return config.skillSnapshot ?? config.profileLaunch?.skillSnapshot;
}

function installationCandidates(
  candidates: SkillInstallation[],
  options: SkillCaptureOptions,
  policy: SkillPolicy,
) {
  const installation = options.installation;
  if (!installation) return { candidates, restricted: false };
  const excludedHashes = new Set(
    installation.definitions
      .filter((definition) => installation.excludedIdentities.includes(definition.identity))
      .map((definition) => definition.sha256),
  );
  const definitions = installation.definitions.filter(
    (definition) => !excludedHashes.has(definition.sha256),
  );
  if (policy.mode === "inherit") {
    for (const definition of definitions)
      if (!candidates.some((skill) => skill.sha256 === definition.sha256))
        throw new SkillLibraryError(
          "shared_skill_unavailable",
          `Install the verified shared content before launching with ${definition.name}`,
        );
  }
  const allowed = new Set(definitions.map((definition) => definition.sha256));
  const available = candidates.filter(
    (skill) => skill.owner !== "personal" || (skill.sha256 !== null && allowed.has(skill.sha256)),
  );
  return {
    candidates: available,
    restricted:
      available.length !== candidates.length || installation.excludedIdentities.length > 0,
  };
}

async function prepareSkillSelection(
  config: AgentSessionConfig,
  provider: string,
  options: SkillCaptureOptions = {},
) {
  const launch = config.profileLaunch;
  const policy = launch?.profile.skillPolicy ?? INHERITED_SKILLS;
  delete config.skillSnapshot;
  if (launch) delete launch.skillSnapshot;
  if (!options.installation && !isRestricted(policy)) return null;
  if (provider !== "claude" && provider !== "codex") {
    if (!isRestricted(policy) && !options.installation?.excludedIdentities.length) return null;
    throw new SkillLibraryError(
      "unsupported_policy",
      "This provider has no verified session skill filter. Use inherited defaults or select a supported Claude or Codex provider.",
    );
  }
  const inventory = await inventorySkills({ home: options.home, cwd: config.cwd });
  const observed = inventory.skills.filter((skill) => skill.providers.includes(provider));
  const available = installationCandidates(observed, options, policy);
  if (!isRestricted(policy) && !available.restricted) return null;
  const candidates = available.candidates;
  let nativeDefaults: string[] | undefined;
  if (policy.mode === "inherit")
    nativeDefaults =
      typeof options.nativeDefaults === "function"
        ? await options.nativeDefaults()
        : options.nativeDefaults;
  return { launch, policy, inventory, observed, candidates, nativeDefaults };
}

export async function captureSkillPolicy(
  config: AgentSessionConfig,
  provider: string,
  options: SkillCaptureOptions = {},
): Promise<void> {
  const prepared = await prepareSkillSelection(config, provider, options);
  if (!prepared) return;
  const { launch, policy, inventory, observed, candidates, nativeDefaults } = prepared;
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
  validateNativeDefaults(nativeDefaults, observed);
  const selectedHashes = new Set(
    candidates.filter((skill) => include.includes(skill.identity)).map((skill) => skill.sha256),
  );
  const exclusions = policy.mode === "inherit" ? policy.exclude : [];
  const excludedHashes = new Set(
    candidates.filter((skill) => exclusions.includes(skill.identity)).map((skill) => skill.sha256),
  );
  const selected = candidates.filter((skill) => {
    if (policy.mode === "none") return false;
    if (policy.mode === "selected") return selectedHashes.has(skill.sha256);
    const enabledByDefault = nativeDefaults ? nativeDefaults.includes(skill.name) : true;
    return (
      (enabledByDefault || selectedHashes.has(skill.sha256)) && !excludedHashes.has(skill.sha256)
    );
  });
  const snapshot: SkillSnapshot = { capturedAt: new Date().toISOString(), provider, skills: [] };
  for (const skill of selected) {
    if (!skill.sha256 || skill.issues.length || (skill.owner === "plugin" && provider !== "codex"))
      throw new SkillLibraryError(
        "unverified_skill",
        `Cannot verify a unique provider selector for ${skill.name}`,
      );
    const conflicting = observed.some(
      (other) => other.name === skill.name && other.sha256 !== skill.sha256,
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
  if (options.installation) config.skillSnapshot = snapshot;
  else if (launch) launch.skillSnapshot = snapshot;
}

export async function verifySkillSnapshot(
  config: AgentSessionConfig,
): Promise<string[] | undefined> {
  const launch = config.profileLaunch;
  const snapshot = sessionSkillSnapshot(config);
  if (!snapshot && !isRestricted(launch?.profile.skillPolicy)) return undefined;
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
  if (snapshot.provider === "claude" && snapshot.skills.length) {
    const current = await inventorySkills({ cwd: config.cwd });
    for (const candidate of current.skills) {
      const selected = snapshot.skills.find((skill) => skill.name === candidate.name);
      if (
        selected &&
        candidate.providers.includes("claude") &&
        candidate.sha256 !== selected.sha256
      )
        throw new SkillLibraryError(
          "ambiguous_skill",
          `Provider selector ${candidate.name} now refers to a different package. Review the profile before continuing.`,
        );
    }
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
