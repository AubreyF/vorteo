import equal from "fast-deep-equal";
import { PluginIdSchema } from "@getpaseo/protocol/plugin-config";
import type {
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import type {
  InstallationPlugin,
  ResolvedPluginSource,
} from "@getpaseo/protocol/plugin-installation";

interface SharedPluginFormPorts {
  resolve(input: { source: string }): Promise<ResolvedPluginSource>;
  save(update: InstallationSettingsUpdate): Promise<unknown>;
}
export type SharedPluginSourceKind = "managed" | "directory";
type PluginSourceReview = ResolvedPluginSource | { kind: "directory"; id: string };

interface SharedPluginFormState {
  sourceKind: SharedPluginSourceKind;
  source: string;
  resolved: PluginSourceReview | null;
  phase: "edit" | "resolving" | "review" | "saving";
  error: string | null;
  resetKey: number;
}

export function openSharedPluginForm(
  ports: SharedPluginFormPorts,
  initial: { source?: string; updateId?: string } = {},
) {
  let state: SharedPluginFormState = {
    sourceKind: "managed",
    source: initial.source ?? "",
    resolved: null,
    phase: "edit",
    error: null,
    resetKey: 0,
  };
  const listeners = new Set<() => void>();
  let generation = 0;
  let closed = false;
  let prepared: {
    revision: number;
    plugins: InstallationPlugin[];
    definition: InstallationPlugin;
  } | null = null;
  function publish(patch: Partial<SharedPluginFormState>) {
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
    setSourceKind(sourceKind: SharedPluginSourceKind) {
      if (closed || initial.updateId || state.phase === "saving" || state.phase === "resolving")
        return;
      generation++;
      prepared = null;
      publish({
        sourceKind,
        source: "",
        resolved: null,
        phase: "edit",
        error: null,
        resetKey: state.resetKey + 1,
      });
    },
    setSource(source: string) {
      if (closed || state.phase === "saving") return;
      generation++;
      prepared = null;
      publish({ source, resolved: null, phase: "edit", error: null });
    },
    async prepare(snapshot: InstallationSettingsSnapshot): Promise<void> {
      if (closed || state.phase === "saving" || state.phase === "resolving" || !state.source.trim())
        return;
      const catalog = snapshot.settings?.plugins;
      if (!catalog) {
        publish({ error: "Wait for shared plugin migration to finish." });
        return;
      }
      const revision = snapshot.revision;
      const plugins = structuredClone(catalog);
      const operation = ++generation;
      prepared = null;
      publish({ phase: "resolving", resolved: null, error: null });
      try {
        const resolved =
          state.sourceKind === "directory"
            ? reviewDirectory(state.source.trim())
            : await ports.resolve({ source: state.source.trim() });
        if (closed || operation !== generation) return;
        const definition = prepareDefinition(plugins, resolved, initial.updateId);
        prepared = { revision, plugins, definition };
        publish({ phase: "review", resolved });
      } catch (error) {
        if (!closed && operation === generation) publish({ phase: "edit", error: message(error) });
      }
    },
    async submit(): Promise<boolean> {
      if (closed || state.phase !== "review" || !prepared) return false;
      const operation = ++generation;
      const { revision, plugins, definition } = prepared;
      publish({ phase: "saving", error: null });
      try {
        await ports.save({
          expectedRevision: revision,
          settings: {
            plugins: initial.updateId
              ? plugins.map((plugin) => (plugin.id === initial.updateId ? definition : plugin))
              : [...plugins, definition],
          },
        });
        if (closed || operation !== generation) return false;
        prepared = null;
        publish({ phase: "edit", source: "", resolved: null, resetKey: state.resetKey + 1 });
        return true;
      } catch (error) {
        if (!closed && operation === generation)
          publish({ phase: "review", error: message(error) });
        return false;
      }
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to save the shared plugin.";
}

function prepareDefinition(
  plugins: InstallationPlugin[],
  resolved: PluginSourceReview,
  updateId: string | undefined,
): InstallationPlugin {
  if (!updateId) {
    if (plugins.some((plugin) => plugin.id === resolved.id))
      throw new Error("This plugin already exists. Open its update controls instead.");
    const source = resolved.kind === "directory" ? { kind: "directory" as const } : resolved;
    return { id: resolved.id, enabled: true, source };
  }
  const existing = plugins.find((plugin) => plugin.id === updateId);
  if (!existing) throw new Error("The selected plugin no longer exists. Reload shared settings.");
  const expected = existing.source;
  if (
    expected.kind === "directory" ||
    resolved.kind === "directory" ||
    !equal(expected.identity, resolved.identity)
  )
    throw new Error(
      "An update must use the same plugin source. Add a different source as a separate plugin.",
    );
  return { ...existing, source: resolved };
}

function reviewDirectory(id: string): PluginSourceReview {
  const parsed = PluginIdSchema.safeParse(id);
  if (!parsed.success)
    throw new Error(
      "Enter a plugin ID starting with a lowercase letter, followed by lowercase letters, numbers or hyphens.",
    );
  return { kind: "directory", id: parsed.data };
}
