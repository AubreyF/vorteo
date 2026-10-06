import { expect, test } from "vitest";
import type { InstallationSettingsUpdate } from "@getpaseo/protocol/installation-settings";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import { createSharedAccountDefinition } from "./account-creation";

function fixture() {
  let snapshot = InstallationSettingsSnapshotSchema.parse({
    version: 1,
    revision: 4,
    sources: {},
    settings: {
      providerDefinitions: [],
      mcp: { injectIntoAgents: false },
      appendSystemPrompt: "",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      metadataGeneration: { providers: [] },
      pluginsEnabled: false,
      terminalProfiles: [],
      resourceExclusions: {},
    },
  });
  const input = {
    creationId: "7a036ed7-5db5-4b4d-85f2-54c1d43ee333",
    provider: "codex" as const,
    name: "Work",
    serverIds: ["host", "container"],
  };
  return {
    input,
    read: async () => snapshot,
    replace(value: typeof snapshot) {
      snapshot = value;
    },
  };
}

test("one account definition binds every environment without carrying credentials", async () => {
  const f = fixture();
  const result = await createSharedAccountDefinition(f.input, {
    read: f.read,
    async save(update) {
      expect(update.expectedRevision).toBe(4);
      const before = await f.read();
      const saved = InstallationSettingsSnapshotSchema.parse({
        ...before,
        revision: 5,
        settings: { ...before.settings, ...update.settings },
      });
      f.replace(saved);
      return saved;
    },
  });
  const definitions = (await f.read()).settings?.providerDefinitions;
  expect(definitions).toHaveLength(1);
  expect(definitions?.[0].bindings).toEqual({
    host: result.providerId,
    container: result.providerId,
  });
  expect(definitions?.[0].accountId).toBeUndefined();
  expect(result.name).toBe("Work");
});

test("a retry after lost acknowledgement uses the saved name and never adds a second definition", async () => {
  const f = fixture();
  let saves = 0;
  const ports = {
    read: f.read,
    async save(update: InstallationSettingsUpdate) {
      saves++;
      const before = await f.read();
      f.replace(
        InstallationSettingsSnapshotSchema.parse({
          ...before,
          revision: 5,
          settings: { ...before.settings, ...update.settings },
        }),
      );
      throw new Error("Reply lost");
    },
  };
  await expect(createSharedAccountDefinition(f.input, ports)).rejects.toThrow("Reply lost");
  await expect(
    createSharedAccountDefinition({ ...f.input, name: "Changed after timeout" }, ports),
  ).resolves.toMatchObject({ name: "Work" });
  expect(saves).toBe(1);
  await expect(
    createSharedAccountDefinition({ ...f.input, provider: "claude" }, ports),
  ).rejects.toThrow("different shared binding");
});

test("a stale revision or owner lock remains a visible failure without inventing local accounts", async () => {
  const f = fixture();
  await expect(
    createSharedAccountDefinition(f.input, {
      read: f.read,
      async save() {
        throw new Error("Shared settings changed");
      },
    }),
  ).rejects.toThrow("Shared settings changed");
  expect((await f.read()).settings?.providerDefinitions).toEqual([]);
  await expect(
    createSharedAccountDefinition(f.input, {
      async read() {
        throw new Error("Unlock Installation controls");
      },
      async save() {
        throw new Error("Must not save");
      },
    }),
  ).rejects.toThrow("Unlock Installation controls");
});
