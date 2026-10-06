import {
  SkillSourceSchema,
  type InstallationSkill,
  type SkillPackage,
  type SkillSource,
} from "@getpaseo/protocol/skill-library";
import type {
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import type { PreparedInstallationSkill } from "@/execution-installation/skills";

interface Ports {
  prepare(source: SkillSource): Promise<PreparedInstallationSkill>;
  read(definition: InstallationSkill): Promise<SkillPackage>;
  save(update: InstallationSettingsUpdate): Promise<unknown>;
}
interface State {
  source: SkillSource;
  phase: "edit" | "preparing" | "review" | "saving";
  review: { current: SkillPackage | null; next: SkillPackage } | null;
  error: string | null;
}
export function openSharedSkillForm(ports: Ports, initial?: InstallationSkill) {
  let state: State = {
    source: initial?.source
      ? { ...initial.source }
      : { repository: "", directory: "", revision: "" },
    phase: "edit",
    review: null,
    error: null,
  };
  let pending: InstallationSettingsUpdate | null = null;
  let generation = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  function publish(patch: Partial<State>) {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      generation++;
      listeners.clear();
    },
    setSource(field: keyof SkillSource, value: string) {
      if (closed || state.phase === "saving") return;
      generation++;
      pending = null;
      publish({
        source: { ...state.source, [field]: value },
        phase: "edit",
        review: null,
        error: null,
      });
    },
    async prepare(snapshot: InstallationSettingsSnapshot) {
      if (closed || state.phase === "saving" || state.phase === "preparing") return;
      const operation = ++generation;
      pending = null;
      publish({ phase: "preparing", review: null, error: null });
      try {
        const { source, catalog, existing } = prepareInputs(state.source, snapshot, initial);
        const revision = snapshot.revision;
        const skills = structuredClone(catalog);
        const [prepared, current] = await Promise.all([
          ports.prepare(source),
          existing ? ports.read(existing) : Promise.resolve(null),
        ]);
        if (closed || operation !== generation) return;
        const definition = prepared.definition;
        if (
          !initial &&
          skills.some(
            (skill) => skill.identity === definition.identity || skill.name === definition.name,
          )
        )
          throw new Error(
            "This skill or directory already exists. Open its update controls instead.",
          );
        if (initial && definition.identity !== initial.identity)
          throw new Error("The prepared package has a different identity.");
        pending = {
          expectedRevision: revision,
          settings: {
            skillLibrary: initial
              ? skills.map((skill) => (skill.identity === initial.identity ? definition : skill))
              : [...skills, definition],
          },
        };
        publish({ phase: "review", review: { current, next: prepared.package } });
      } catch (error) {
        if (!closed && operation === generation) publish({ phase: "edit", error: message(error) });
      }
    },
    async submit() {
      if (closed || state.phase !== "review" || !pending) return false;
      const operation = ++generation;
      publish({ phase: "saving", error: null });
      try {
        await ports.save(pending);
        if (closed || operation !== generation) return false;
        pending = null;
        publish({ phase: "edit", review: null });
        return true;
      } catch (error) {
        if (!closed && operation === generation)
          publish({ phase: "review", error: message(error) });
        return false;
      }
    },
  };
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "Unable to save the shared skill.";
}

function prepareInputs(
  input: SkillSource,
  snapshot: InstallationSettingsSnapshot,
  initial?: InstallationSkill,
) {
  const parsed = SkillSourceSchema.safeParse(
    Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.trim()])),
  );
  if (!parsed.success)
    throw new Error("Enter a repository, skill directory, and full 40-character commit SHA.");
  const source = parsed.data;
  const catalog = snapshot.settings?.skillLibrary;
  if (!catalog) throw new Error("Wait for shared skill migration to finish.");
  const existing = initial
    ? catalog.find((skill) => skill.identity === initial.identity)
    : undefined;
  if (initial && !existing) throw new Error("This skill no longer exists. Reload shared settings.");
  if (
    initial &&
    (!existing?.source ||
      source.repository !== existing.source.repository ||
      source.directory !== existing.source.directory)
  )
    throw new Error("Use the same repository and directory when updating a skill.");
  return { source, catalog, existing };
}
