import { expect, test } from "vitest";
import type { InstallationSettings } from "@getpaseo/protocol/installation-settings";
import {
  defaultConflictChoices,
  describeConflictValue,
  duplicateSkills,
  fieldNeedsChoice,
  resolveConflicts,
  type SettingsConflicts,
} from "./settings-conflicts";

const HOST = "srv_host";
const DEV = "srv_dev";

function skill(name: string, sha: string) {
  return { name, sha256: sha.repeat(64).slice(0, 64), source: null, identity: `content:${sha}` };
}

function settings(overrides: Partial<InstallationSettings>): InstallationSettings {
  return {
    mcp: { injectIntoAgents: false },
    appendSystemPrompt: "",
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    metadataGeneration: { providers: [] },
    pluginsEnabled: true,
    terminalProfiles: [],
    resourceExclusions: {},
    ...overrides,
  };
}

// The first lab install: MCP defaults differed, and the Host had two copies of one skill.
const library = [skill("figma", "a"), skill("no-ai-slop", "b"), skill("no-ai-slop", "c")];
const conflicts: SettingsConflicts = {
  fields: ["skillLibrary", "mcp"],
  candidates: {
    [DEV]: settings({ mcp: { injectIntoAgents: true }, skillLibrary: library }),
    [HOST]: settings({ mcp: { injectIntoAgents: false }, skillLibrary: library }),
  },
};

test("values read as plain language, not JSON", () => {
  expect(describeConflictValue("mcp", conflicts.candidates[DEV])).toBe("On");
  expect(describeConflictValue("mcp", conflicts.candidates[HOST])).toBe("Off");
  expect(describeConflictValue("skillLibrary", conflicts.candidates[HOST])).toBe(
    "3 skills: figma, no-ai-slop, no-ai-slop",
  );
});

test("an identical field needs no environment choice, but its duplicate skills do", () => {
  expect(fieldNeedsChoice("mcp", conflicts)).toBe(true);
  expect(fieldNeedsChoice("skillLibrary", conflicts)).toBe(false);
  expect(duplicateSkills(conflicts)).toEqual([
    { name: "no-ai-slop", versions: [library[1], library[2]] },
  ]);
});

test("saving waits for every duplicated skill, then keeps exactly one version", () => {
  const choices = defaultConflictChoices(conflicts, HOST);
  expect(choices.fields).toEqual({ mcp: HOST });
  expect(resolveConflicts(conflicts, choices)).toBeNull();
  const resolved = resolveConflicts(conflicts, {
    ...choices,
    skills: { "no-ai-slop": library[2].identity },
  });
  expect(resolved?.mcp).toEqual({ injectIntoAgents: false });
  expect(resolved?.skillLibrary).toEqual([library[0], library[2]]);
});

test("a kept version reported by only one environment stays in the library", () => {
  const split: SettingsConflicts = {
    fields: ["skillLibrary"],
    candidates: {
      [HOST]: settings({ skillLibrary: [library[1]] }),
      [DEV]: settings({ skillLibrary: [library[2]] }),
    },
  };
  const resolved = resolveConflicts(split, {
    fields: { skillLibrary: HOST },
    skills: { "no-ai-slop": library[2].identity },
  });
  expect(resolved?.skillLibrary).toEqual([library[2]]);
});
