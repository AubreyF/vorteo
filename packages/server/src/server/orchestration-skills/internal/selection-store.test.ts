import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonConfigStore, type MutableDaemonConfigPatch } from "../../daemon-config-store";
import { loadPersistedConfig } from "../../persisted-config";
import { createSkillSelectionStore } from "./selection-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-skills-config-"));
  roots.push(root);
  const config = new DaemonConfigStore(root, {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });
  return { config, root, store: createSkillSelectionStore(config) };
}

describe("daemon agent skill selection", () => {
  it("defaults missing selection to all without persisting it", async () => {
    const { root, store } = await createStore();
    expect(await store.get()).toEqual({ mode: "all" });
    expect(await store.isSet()).toBe(false);
    expect(loadPersistedConfig(root).agents?.skills).toBeUndefined();
  });

  it("persists a normalized custom selection under agents.skills.selection", async () => {
    const { root, store } = await createStore();
    await store.set({ mode: "custom", skills: ["paseo-loop", "paseo", "paseo"] });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({
      mode: "custom",
      skills: ["paseo", "paseo-loop"],
    });
  });

  it("replaces a custom selection with all without retaining custom skill names", async () => {
    const { config, root, store } = await createStore();
    await store.set({ mode: "custom", skills: ["paseo"] });

    await store.set({ mode: "all" });

    expect(config.get().skills?.selection).toEqual({ mode: "all" });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({ mode: "all" });
  });

  // Vorteo routes selection through the config patch so installation settings admission applies.
  it("shares one persisted selection with the config patch path", async () => {
    const { config, root, store } = await createStore();

    config.patch({
      skills: { selection: { mode: "custom", skills: ["paseo"] } },
    } satisfies MutableDaemonConfigPatch);

    expect(await store.isSet()).toBe(true);
    expect(await store.get()).toEqual({ mode: "custom", skills: ["paseo"] });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({
      mode: "custom",
      skills: ["paseo"],
    });
  });
});
