import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSessionConfig } from "../../agent/agent-sdk-types.js";
import type {
  SkillPolicy,
  SkillSnapshot,
  InstallationSkill,
  SkillInstallation,
  SkillInventory,
} from "@getpaseo/protocol/skill-library";
import {
  inventorySkills,
  readPackage,
  skillMetadata,
  skillRoots,
  SkillLibraryError,
} from "./inventory.js";

export function isRestricted(policy: SkillPolicy | undefined): boolean {
  if (!policy) return false;
  return policy.mode !== "inherit" || policy.include.length > 0 || policy.exclude.length > 0;
}

interface SkillCaptureOptions {
  home?: string;
  nativeDefaults?: string[] | (() => Promise<string[]>);
  /** Skills the provider labels as bundled with its own binary; read only for inherited restrictions. */
  providerBuiltins?: () => Promise<string[]>;
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
  // Provider defaults without an inspectable package cannot be hash-pinned, so only skills
  // Claude itself labels as bundled are kept, by name. Every other unpackaged default (account,
  // plugin and command names the inventory cannot see) stays out. Codex filters by package
  // path, so bundled names stay out there.
  const builtins = await bundledSkillNames(provider, policy, options, observed);
  if (builtins.length) snapshot.builtins = builtins;
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
  options: { claudeConfigDir?: string } = {},
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
  let builtins = snapshot.builtins ?? [];
  if (snapshot.provider === "claude" && (snapshot.skills.length || builtins.length)) {
    const current = await inventorySkills({
      cwd: config.cwd,
      claudeConfigDir: options.claudeConfigDir,
    });
    // A package that later claims a built-in name would be enabled by that name, so the
    // name is turned off instead of admitting an unverified package. Plugin skills claim
    // their bare name, which Claude's allowlist matches as a ":name" suffix. If any root
    // could not be read, a claim may be hidden, so no built-ins are kept.
    const claimed = await claimedSkillNames(current);
    builtins = claimed ? builtins.filter((name) => !claimed.has(name)) : [];
    // Config-folder roots join the inventory only to find claims on built-in names; the
    // package selector check keeps its earlier scope.
    const baseline = (await skillRoots(os.homedir(), config.cwd)).map((root) => root.path);
    const packaged = current.skills.filter((skill) =>
      baseline.some((root) => skill.path.startsWith(root + path.sep)),
    );
    for (const candidate of packaged) {
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
  return [...new Set([...snapshot.skills.map((skill) => skill.name), ...builtins])];
}

async function bundledSkillNames(
  provider: string,
  policy: SkillPolicy,
  options: SkillCaptureOptions,
  observed: Array<{ name: string; path: string }>,
): Promise<string[]> {
  if (provider !== "claude" || policy.mode !== "inherit" || !options.providerBuiltins) return [];
  const names = await options.providerBuiltins();
  // Plugin-qualified names are never bundled, and a package using the name would be enabled
  // by it, so both stay out.
  const bundled = names.filter(
    (name) => !name.includes(":") && !observed.some((skill) => packageNames(skill).includes(name)),
  );
  return [...new Set(bundled)].sort();
}

// Claude's skill allowlist matches a package's frontmatter name or its folder name.
function packageNames(skill: { name: string; path: string }): string[] {
  return [skill.name, path.basename(skill.path)];
}

/** Every name a Claude skill in the inventory claims; null when some claim is unknown. */
async function claimedSkillNames(inventory: SkillInventory): Promise<Set<string> | null> {
  if (inventory.roots.some((root) => root.status === "error")) return null;
  const claimed = new Set<string>();
  for (const skill of inventory.skills) {
    if (!skill.providers.includes("claude")) continue;
    const names = await claimedNames(skill);
    if (!names) return null;
    for (const name of names) claimed.add(name);
  }
  return claimed;
}

/**
 * Names a skill can be enabled by. Inventory records a package it could not fully read
 * (symlinked files, size limits) under its folder name, so read the frontmatter name
 * directly; null when even that fails, because the claimed name is then unknown.
 */
async function claimedNames(skill: SkillInstallation): Promise<string[] | null> {
  if (!skill.issues.length) return packageNames(skill);
  try {
    const { name } = skillMetadata(await readFile(path.join(skill.path, "SKILL.md")));
    return [name, path.basename(skill.path)];
  } catch {
    return null;
  }
}
