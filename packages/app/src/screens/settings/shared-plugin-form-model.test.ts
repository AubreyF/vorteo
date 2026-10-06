import { expect, test, vi } from "vitest";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import type { ResolvedPluginSource } from "@getpaseo/protocol/plugin-installation";
import { openSharedPluginForm } from "./shared-plugin-form-model";

const resolved: ResolvedPluginSource = {
  kind: "git",
  id: "example",
  identity: { kind: "git", remote: "https://example.test/plugin.git", pluginPath: "." },
  target: { kind: "git", commit: "a".repeat(40) },
};
function snapshot() {
  return InstallationSettingsSnapshotSchema.parse({
    version: 1,
    revision: 7,
    sources: {},
    settings: {
      plugins: [],
      pluginsEnabled: true,
      mcp: { injectIntoAgents: false },
      appendSystemPrompt: "saved",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      metadataGeneration: { providers: [] },
      terminalProfiles: [],
      resourceExclusions: {},
    },
  });
}

test("preparation never installs and saving retains the reviewed revision through a conflict", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("Shared settings changed"));
  const model = openSharedPluginForm({ resolve: async () => resolved, save });
  model.setSource("  owner/example  ");
  const opened = snapshot();
  await model.prepare(opened);
  expect(save).not.toHaveBeenCalled();
  opened.revision = 8;
  expect(await model.submit()).toBe(false);
  expect(save).toHaveBeenCalledWith({
    expectedRevision: 7,
    settings: { plugins: [{ id: "example", enabled: true, source: resolved }] },
  });
  expect(model.getState()).toMatchObject({
    source: "  owner/example  ",
    resolved,
    phase: "review",
    error: "Shared settings changed",
  });
  save.mockResolvedValueOnce(undefined);
  await model.prepare(opened);
  expect(await model.submit()).toBe(true);
  expect(save.mock.lastCall?.[0].expectedRevision).toBe(8);
  expect(model.getState()).toMatchObject({
    source: "",
    resolved: null,
    phase: "edit",
    resetKey: 1,
  });
});

test("source edits and closure prevent late preparation results from selecting the wrong artifact", async () => {
  let complete!: (value: ResolvedPluginSource) => void;
  const save = vi.fn();
  const model = openSharedPluginForm({
    resolve: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    save,
  });
  model.setSource("first/source");
  const preparing = model.prepare(snapshot());
  model.setSource("second/source");
  complete(resolved);
  await preparing;
  expect(model.getState()).toMatchObject({
    source: "second/source",
    resolved: null,
    phase: "edit",
  });
  const next = model.prepare(snapshot());
  model.close();
  complete(resolved);
  await next;
  expect(await model.submit()).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

test("duplicate IDs are not replaced and updates retain disabled aliases", async () => {
  const existing = snapshot();
  if (!existing.settings) throw new Error("Missing fixture settings");
  existing.settings.plugins = [{ id: "saved-alias", enabled: false, source: resolved }];
  const save = vi.fn().mockResolvedValue(undefined);
  const update = openSharedPluginForm(
    {
      resolve: async () => ({ ...resolved, target: { kind: "git", commit: "b".repeat(40) } }),
      save,
    },
    { source: "owner/example", updateId: "saved-alias" },
  );
  await update.prepare(existing);
  expect(await update.submit()).toBe(true);
  expect(save.mock.lastCall?.[0].settings.plugins[0]).toMatchObject({
    id: "saved-alias",
    enabled: false,
  });
  existing.settings.plugins = [{ id: "example", enabled: true, source: resolved }];
  const duplicate = openSharedPluginForm(
    { resolve: async () => resolved, save },
    { source: "owner/example" },
  );
  await duplicate.prepare(existing);
  expect(duplicate.getState().error).toContain("already exists");
  expect(await duplicate.submit()).toBe(false);
  expect(save).toHaveBeenCalledOnce();
});

test("completion after closing the form cannot dismiss a later form", async () => {
  let finish: (() => void) | undefined;
  const model = openSharedPluginForm({
    resolve: async () => resolved,
    save: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  model.setSource("owner/plugin");
  await model.prepare(snapshot());
  const saving = model.submit();
  model.close();
  if (!finish) throw new Error("Save did not start");
  finish();
  expect(await saving).toBe(false);
});

test("directory definitions save once without copying or resolving any environment path", async () => {
  const resolve = vi.fn(async () => resolved);
  const save = vi.fn().mockResolvedValue(undefined);
  const model = openSharedPluginForm({ resolve, save });
  model.setSourceKind("directory");
  model.setSource("/private/plugin");
  await model.prepare(snapshot());
  expect(model.getState().error).toContain("plugin ID");
  expect(await model.submit()).toBe(false);
  model.setSource("local-review");
  await model.prepare(snapshot());
  expect(model.getState().resolved).toEqual({ kind: "directory", id: "local-review" });
  expect(resolve).not.toHaveBeenCalled();
  expect(await model.submit()).toBe(true);
  expect(save).toHaveBeenCalledWith({
    expectedRevision: 7,
    settings: { plugins: [{ id: "local-review", enabled: true, source: { kind: "directory" } }] },
  });
});
