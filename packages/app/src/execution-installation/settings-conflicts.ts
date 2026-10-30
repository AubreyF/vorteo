import type {
  InstallationSettings,
  InstallationSettingsField,
} from "@getpaseo/protocol/installation-settings";

type Skill = NonNullable<InstallationSettings["skillLibrary"]>[number];

export interface SettingsConflicts {
  fields: InstallationSettingsField[];
  candidates: Record<string, InstallationSettings>;
}

/** The owner's picks: one environment per differing field, one version per duplicated skill. */
export interface ConflictChoices {
  fields: Partial<Record<InstallationSettingsField, string>>;
  skills: Record<string, string>;
}

const FIELD_LABELS: Record<InstallationSettingsField, string> = {
  browserTools: "Browser tools",
  providerDefinitions: "Providers",
  plugins: "Plugins",
  skillLibrary: "Skill library",
  skills: "Enabled skills",
  mcp: "Vorteo tools for agents (MCP)",
  appendSystemPrompt: "Extra system prompt",
  autoArchiveAfterMerge: "Archive workspaces after merge",
  enableTerminalAgentHooks: "Terminal agent hooks",
  metadataGeneration: "Title and summary generation",
  pluginsEnabled: "Plugins",
  terminalProfiles: "Terminal profiles",
  resourceExclusions: "Per-environment exclusions",
  projectPolicies: "Project policies",
};

export function conflictFieldLabel(field: InstallationSettingsField): string {
  return FIELD_LABELS[field] ?? field;
}

function onOff(value: boolean | undefined): string {
  if (value === undefined) return "Not set";
  return value ? "On" : "Off";
}

function itemName(item: unknown): string {
  if (typeof item !== "object" || item === null) return String(item);
  for (const key of ["name", "label", "title", "provider", "id"]) {
    const value = Reflect.get(item, key);
    if (typeof value === "string" && value) return value;
  }
  return "item";
}

function list(items: readonly unknown[], noun: string): string {
  if (!items.length) return `No ${noun}`;
  const names = items.map(itemName);
  const shown = names.slice(0, 6).join(", ");
  const more = names.length > 6 ? `, and ${names.length - 6} more` : "";
  return `${items.length} ${noun}: ${shown}${more}`;
}

function promptSummary(prompt: string): string {
  const text = prompt.trim();
  if (!text) return "Empty";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

const DESCRIBE: Partial<
  Record<InstallationSettingsField, (settings: InstallationSettings) => string>
> = {
  mcp: (settings) => onOff(settings.mcp?.injectIntoAgents),
  browserTools: (settings) => onOff(settings.browserTools?.enabled),
  autoArchiveAfterMerge: (settings) => onOff(settings.autoArchiveAfterMerge),
  enableTerminalAgentHooks: (settings) => onOff(settings.enableTerminalAgentHooks),
  pluginsEnabled: (settings) => onOff(settings.pluginsEnabled),
  appendSystemPrompt: (settings) => promptSummary(settings.appendSystemPrompt),
  skillLibrary: (settings) => list(settings.skillLibrary ?? [], "skills"),
  providerDefinitions: (settings) => list(settings.providerDefinitions ?? [], "providers"),
  plugins: (settings) => list(settings.plugins ?? [], "plugins"),
  terminalProfiles: (settings) => list(settings.terminalProfiles, "profiles"),
  metadataGeneration: (settings) => list(settings.metadataGeneration.providers, "providers"),
  skills: (settings) => (settings.skills ? "Custom selection" : "Not set"),
  resourceExclusions: (settings) =>
    `${Object.keys(settings.resourceExclusions).length} environments with exclusions`,
  projectPolicies: (settings) =>
    `${Object.keys(settings.projectPolicies ?? {}).length} project policies`,
};

/** One line a person can compare at a glance, never a JSON dump. */
export function describeConflictValue(
  field: InstallationSettingsField,
  settings: InstallationSettings,
): string {
  return DESCRIBE[field]?.(settings) ?? "Differs";
}

export interface DuplicateSkill {
  name: string;
  versions: Skill[];
}

/**
 * Shared settings refuse two skills with one name, so the owner must keep one version.
 * Versions are listed once even when several environments report them.
 */
export function duplicateSkills(conflicts: SettingsConflicts): DuplicateSkill[] {
  if (!conflicts.fields.includes("skillLibrary")) return [];
  const byName = new Map<string, Map<string, Skill>>();
  for (const candidate of Object.values(conflicts.candidates))
    for (const skill of candidate.skillLibrary ?? []) {
      const versions = byName.get(skill.name) ?? new Map<string, Skill>();
      versions.set(skill.identity, skill);
      byName.set(skill.name, versions);
    }
  return [...byName]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions.values()] }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Fields whose values are the same everywhere need no environment choice. */
export function fieldNeedsChoice(
  field: InstallationSettingsField,
  conflicts: SettingsConflicts,
): boolean {
  const values = Object.values(conflicts.candidates).map((candidate) =>
    JSON.stringify(candidate[field] ?? null),
  );
  return new Set(values).size > 1;
}

export function defaultConflictChoices(
  conflicts: SettingsConflicts,
  hostServerId: string | undefined,
): ConflictChoices {
  const fallback = hostServerId ?? Object.keys(conflicts.candidates)[0];
  const fields: ConflictChoices["fields"] = {};
  for (const field of conflicts.fields)
    if (fieldNeedsChoice(field, conflicts)) fields[field] = fallback;
  return { fields, skills: {} };
}

/** Null until every differing field and every duplicated skill has a choice. */
export function resolveConflicts(
  conflicts: SettingsConflicts,
  choices: ConflictChoices,
): Partial<InstallationSettings> | null {
  const fallback = Object.keys(conflicts.candidates)[0];
  const resolved: Partial<InstallationSettings> = {};
  for (const field of conflicts.fields) {
    const serverId = fieldNeedsChoice(field, conflicts) ? choices.fields[field] : fallback;
    const candidate = serverId ? conflicts.candidates[serverId] : undefined;
    if (!candidate) return null;
    Reflect.set(resolved, field, structuredClone(candidate[field]));
  }
  const duplicates = duplicateSkills(conflicts);
  if (duplicates.some((duplicate) => !choices.skills[duplicate.name])) return null;
  if (resolved.skillLibrary) {
    resolved.skillLibrary = resolved.skillLibrary.filter((skill) => {
      const kept = choices.skills[skill.name];
      return kept === undefined || kept === skill.identity;
    });
    // A kept version that only another environment reported still belongs in the library.
    for (const duplicate of duplicates) {
      const identity = choices.skills[duplicate.name];
      if (resolved.skillLibrary.some((skill) => skill.identity === identity)) continue;
      const version = duplicate.versions.find((skill) => skill.identity === identity);
      if (version) resolved.skillLibrary.push(structuredClone(version));
    }
  }
  return resolved;
}
