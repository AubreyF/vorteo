import type {
  InstallationSkill,
  SkillLibraryRead,
  SkillLibraryResult,
} from "@getpaseo/protocol/skill-library";
import { isDeepStrictEqual } from "node:util";
import type { InstallationSkillPackages } from "./skill-packages.js";

interface SkillInventoryPort {
  readSkillLibrary(request: SkillLibraryRead): Promise<SkillLibraryResult>;
}
interface SkillCatalogConflict {
  identity: string;
  candidates: Record<string, InstallationSkill[]>;
}

export async function collectInstallationSkills(
  port: SkillInventoryPort,
  packages: InstallationSkillPackages,
): Promise<InstallationSkill[]> {
  const result = await port.readSkillLibrary({ kind: "inventory" });
  if (result.kind !== "inventory") throw new Error("Expected the personal skill inventory");
  if (result.inventory.roots.some((root) => root.status === "error"))
    throw new Error("Skill discovery is incomplete; preserve the existing catalog");
  const definitions: InstallationSkill[] = [];
  for (const skill of result.inventory.skills) {
    if (skill.owner !== "personal") continue;
    if (skill.issues.length || !skill.sha256)
      throw new Error("A personal skill needs inspection before catalog migration");
    const exported = await port.readSkillLibrary({ kind: "package", id: skill.id });
    if (exported.kind !== "package" || exported.package.sha256 !== skill.sha256)
      throw new Error("A personal skill changed while collecting the catalog");
    const definition = packages.save(exported.package);
    if (definition.identity !== skill.identity)
      throw new Error("A personal skill identity changed while collecting the catalog");
    if (
      !definitions.some(
        (existing) =>
          existing.identity === definition.identity &&
          existing.sha256 === definition.sha256 &&
          isDeepStrictEqual(existing.source, definition.source),
      )
    )
      definitions.push(definition);
  }
  return definitions.toSorted((left, right) => left.identity.localeCompare(right.identity));
}

/** Every variant is retained in protected storage before a canonical choice can be made. */
export function mergeInstallationSkills(observations: Record<string, InstallationSkill[]>) {
  const definitions = new Map<string, InstallationSkill>();
  for (const entries of Object.values(observations))
    for (const entry of entries)
      if (!definitions.has(entry.identity)) definitions.set(entry.identity, structuredClone(entry));
  const conflicts: SkillCatalogConflict[] = [];
  for (const [identity, definition] of definitions) {
    const candidates: Record<string, InstallationSkill[]> = {};
    let differs = false;
    for (const [environment, entries] of Object.entries(observations)) {
      const matching = entries.filter((entry) => entry.identity === identity);
      if (!matching.length) continue;
      candidates[environment] = structuredClone(matching);
      if (
        matching.some(
          (entry) =>
            entry.sha256 !== definition.sha256 ||
            !isDeepStrictEqual(entry.source, definition.source),
        )
      )
        differs = true;
    }
    if (differs) conflicts.push({ identity, candidates });
  }
  const candidates: Record<string, InstallationSkill[]> = {};
  let needsReview = conflicts.length > 0;
  for (const [environment, local] of Object.entries(observations)) {
    candidates[environment] = [...definitions.values()]
      .flatMap((definition) => {
        const matching = local.filter((skill) => skill.identity === definition.identity);
        return matching.length ? structuredClone(matching) : [structuredClone(definition)];
      })
      .sort((left, right) => left.identity.localeCompare(right.identity));
    const identities = candidates[environment].map((skill) => skill.identity);
    const names = candidates[environment].map((skill) => skill.name);
    if (new Set(identities).size !== identities.length || new Set(names).size !== names.length)
      needsReview = true;
  }
  return {
    definitions: [...definitions.values()].sort((left, right) =>
      left.identity.localeCompare(right.identity),
    ),
    conflicts,
    candidates,
    needsReview,
  };
}

interface SkillProjectionPort extends SkillInventoryPort {
  changeSkillLibrary(
    request: import("@getpaseo/protocol/skill-library").SkillLibraryChange,
  ): Promise<SkillLibraryResult>;
}

export async function installationSkillsSettled(
  port: SkillInventoryPort,
  definitions: readonly InstallationSkill[],
): Promise<boolean> {
  const inventory = await port.readSkillLibrary({ kind: "inventory" });
  if (inventory.kind !== "inventory") throw new Error("Expected the personal skill inventory");
  return definitions.every((definition) => {
    const matching = inventory.inventory.skills.filter(
      (skill) => skill.owner === "personal" && skill.identity === definition.identity,
    );
    return (
      matching.length > 0 &&
      matching.every((skill) => skill.sha256 === definition.sha256 && !skill.issues.length) &&
      ["codex", "claude"].every((provider) =>
        matching.some((skill) => skill.providers.includes(provider)),
      )
    );
  });
}

export async function projectInstallationSkills(
  port: SkillProjectionPort,
  definitions: readonly InstallationSkill[],
  packages: InstallationSkillPackages,
): Promise<void> {
  const names = definitions.map((definition) => definition.name);
  const identities = definitions.map((definition) => definition.identity);
  if (new Set(names).size !== names.length || new Set(identities).size !== identities.length)
    throw new Error("Resolve conflicting skill identities and directory names before projection");
  for (const definition of definitions) {
    if (await installationSkillsSettled(port, [definition])) continue;
    const preview = await port.changeSkillLibrary({
      kind: "preview_import",
      package: packages.read(definition),
    });
    if (preview.kind !== "preview") throw new Error("Expected a shared skill installation preview");
    await port.changeSkillLibrary({ kind: "apply", previewId: preview.preview.id });
    const inventory = await port.readSkillLibrary({ kind: "inventory" });
    if (inventory.kind !== "inventory") throw new Error("Expected the installed skill inventory");
    const canonical = inventory.inventory.skills.find(
      (skill) => skill.path === preview.preview.target,
    );
    if (!canonical || canonical.sha256 !== definition.sha256)
      throw new Error("Shared skill installation did not retain the reviewed content");
    const claude = inventory.inventory.skills.some(
      (skill) =>
        skill.identity === definition.identity &&
        skill.sha256 === definition.sha256 &&
        skill.providers.includes("claude"),
    );
    if (!claude) {
      const link = await port.changeSkillLibrary({
        kind: "preview_link",
        id: canonical.id,
        provider: "claude",
      });
      if (link.kind !== "preview") throw new Error("Expected a provider discovery preview");
      await port.changeSkillLibrary({ kind: "apply", previewId: link.preview.id });
    }
    if (!(await installationSkillsSettled(port, [definition])))
      throw new Error(
        "A conflicting local skill copy needs review before this projection can finish",
      );
  }
}
