import { expect, test, vi } from "vitest";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import type { PreparedInstallationSkill } from "@/execution-installation/skills";
import { openSharedSkillForm } from "./shared-form-model";
const source = { repository: "owner/repo", directory: "skills/example", revision: "a".repeat(40) };
const prepared: PreparedInstallationSkill = {
  definition: {
    name: "example",
    source,
    sha256: "b".repeat(64),
    identity: "github:owner/repo/skills/example",
  },
  package: {
    name: "example",
    source,
    sha256: "b".repeat(64),
    files: [{ path: "SKILL.md", content: "cmV2aWV3", executable: false }],
  },
};
function snapshot() {
  return InstallationSettingsSnapshotSchema.parse({
    version: 1,
    revision: 7,
    sources: {},
    settings: {
      skillLibrary: [],
      mcp: { injectIntoAgents: false },
      appendSystemPrompt: "preserved",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      metadataGeneration: { providers: [] },
      pluginsEnabled: true,
      terminalProfiles: [],
      resourceExclusions: {},
    },
  });
}
function fill(model: ReturnType<typeof openSharedSkillForm>) {
  model.setSource("repository", source.repository);
  model.setSource("directory", source.directory);
  model.setSource("revision", source.revision);
}
test("review freezes the catalog revision and retains source and bytes through failed saves", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("Shared settings changed"));
  const model = openSharedSkillForm({ prepare: async () => prepared, read: vi.fn(), save });
  fill(model);
  const opened = snapshot();
  await model.prepare(opened);
  opened.revision = 8;
  expect(save).not.toHaveBeenCalled();
  expect(await model.submit()).toBe(false);
  expect(save).toHaveBeenCalledWith({
    expectedRevision: 7,
    settings: { skillLibrary: [prepared.definition] },
  });
  expect(model.getState()).toMatchObject({
    source,
    phase: "review",
    review: { current: null, next: prepared.package },
    error: "Shared settings changed",
  });
  await model.prepare(opened);
  save.mockResolvedValueOnce(undefined);
  expect(await model.submit()).toBe(true);
  expect(save.mock.lastCall?.[0].expectedRevision).toBe(8);
});
test("updates review previous content and do not replace another source or directory", async () => {
  const opened = snapshot();
  if (!opened.settings) throw new Error("Missing fixture");
  opened.settings.skillLibrary = [prepared.definition];
  const read = vi.fn(async () => prepared.package);
  const resolve = vi.fn(async () => prepared);
  const save = vi.fn();
  const model = openSharedSkillForm({ prepare: resolve, read, save }, prepared.definition);
  model.setSource("directory", "skills/different");
  await model.prepare(opened);
  expect(resolve).not.toHaveBeenCalled();
  expect(model.getState().error).toContain("same repository");
  model.setSource("directory", source.directory);
  await model.prepare(opened);
  expect(read).toHaveBeenCalledWith(prepared.definition);
  expect(model.getState().review?.current).toEqual(prepared.package);
  expect(await model.submit()).toBe(true);
  expect(save).toHaveBeenCalledWith({
    expectedRevision: 7,
    settings: { skillLibrary: [prepared.definition] },
  });
  const add = openSharedSkillForm({ prepare: resolve, read, save });
  fill(add);
  await add.prepare(opened);
  expect(add.getState().error).toContain("already exists");
  expect(await add.submit()).toBe(false);
});
test("late responses cannot restore stale review after editing or closing", async () => {
  let finish!: (value: PreparedInstallationSkill) => void;
  const save = vi.fn();
  const model = openSharedSkillForm({
    prepare: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    read: vi.fn(),
    save,
  });
  fill(model);
  const first = model.prepare(snapshot());
  model.setSource("revision", "c".repeat(40));
  finish(prepared);
  await first;
  expect(model.getState()).toMatchObject({ phase: "edit", review: null });
  const second = model.prepare(snapshot());
  model.close();
  finish(prepared);
  await second;
  expect(await model.submit()).toBe(false);
  expect(save).not.toHaveBeenCalled();
});
