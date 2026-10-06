import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureSkillPolicy, verifySkillSnapshot } from "./policy";
import { codexSkillFilter } from "./codex-policy";
import { inventorySkills } from "./inventory";
import type { AgentSessionConfig } from "../../agent/agent-sdk-types";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-policy-"));
  directories.push(home);
  const directory = path.join(home, ".claude/skills/example");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    "---\nname: example\ndescription: test\n---\nTest",
  );
  const skill = (await inventorySkills({ home })).skills[0];
  const config: AgentSessionConfig = {
    provider: "claude",
    cwd: home,
    profileLaunch: {
      profile: {
        id: "review",
        name: "Review",
        provider: "claude",
        skillPolicy: { mode: "selected", skills: [skill.identity] },
      },
    },
  };
  return { home, directory, skill, config };
}
it("freezes selections independently and refuses changed package contents", async () => {
  const { home, directory, config } = await setup();
  await captureSkillPolicy(config, "claude", { home });
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
  const second = structuredClone(config);
  second.profileLaunch!.profile.skillPolicy = { mode: "none" };
  await captureSkillPolicy(second, "claude", { home });
  expect(await verifySkillSnapshot(second)).toEqual([]);
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
  await writeFile(path.join(directory, "script.sh"), "Changed code");
  await expect(verifySkillSnapshot(config)).rejects.toThrow("changed after launch");
});
it("refuses unsupported providers and missing selected identities", async () => {
  const { home, config } = await setup();
  await expect(captureSkillPolicy(config, "unknown", { home })).rejects.toThrow("no verified");
  config.profileLaunch!.profile.skillPolicy = { mode: "selected", skills: ["unavailable"] };
  await expect(captureSkillPolicy(config, "claude", { home })).rejects.toThrow("unavailable");
});
it("excludes equivalent packages without relying on display names", async () => {
  const { home, config, skill } = await setup();
  config.profileLaunch!.profile.skillPolicy = {
    mode: "inherit",
    include: [],
    exclude: [skill.identity],
  };
  await captureSkillPolicy(config, "claude", { home });
  expect(await verifySkillSnapshot(config)).toEqual([]);
});
it("maps native Codex paths to an explicit session allowlist", () => {
  const selectedDirectory = path.resolve("selected");
  const selectedPath = path.join(selectedDirectory, "SKILL.md");
  const otherPath = path.resolve("other", "SKILL.md");
  const snapshot = {
    capturedAt: "now",
    provider: "codex",
    skills: [{ identity: "one", name: "same-name", path: selectedDirectory, sha256: "hash" }],
  };
  expect(
    codexSkillFilter(snapshot, [
      { name: "same-name", path: selectedPath },
      { name: "same-name", path: otherPath },
    ]),
  ).toEqual([
    { path: selectedPath, enabled: true },
    { path: otherPath, enabled: false },
  ]);
  expect(() => codexSkillFilter(snapshot, [])).toThrow("did not discover");
});

it("does not enable installed packages that the provider disabled by default", async () => {
  const { home, config, skill } = await setup();
  config.profileLaunch!.profile.skillPolicy = {
    mode: "inherit",
    include: [],
    exclude: ["another-identity"],
  };
  await captureSkillPolicy(config, "claude", { home, nativeDefaults: [] });
  expect(await verifySkillSnapshot(config)).toEqual([]);
  config.profileLaunch!.profile.skillPolicy = {
    mode: "inherit",
    include: [skill.identity],
    exclude: [],
  };
  await captureSkillPolicy(config, "claude", { home, nativeDefaults: [] });
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
});

it("excludes identical copies even when only one has source provenance", async () => {
  const { home, directory, config } = await setup();
  const duplicate = path.join(home, ".claude/skills/duplicate");
  await cp(directory, duplicate, { recursive: true });
  await writeFile(
    path.join(directory, ".vorteo-skill-source.json"),
    JSON.stringify({
      repository: "example/skills",
      revision: "a".repeat(40),
      directory: "skills/example",
    }),
  );
  const installed = (await inventorySkills({ home })).skills.find(
    (skill) => skill.path === directory,
  )!;
  config.profileLaunch!.profile.skillPolicy = {
    mode: "inherit",
    include: [],
    exclude: [installed.identity],
  };
  await captureSkillPolicy(config, "claude", { home, nativeDefaults: ["example"] });
  expect(await verifySkillSnapshot(config)).toEqual([]);
});

it("applies installation exclusions without a profile and keeps an older task's frozen selection", async () => {
  const { home, skill, config } = await setup();
  delete config.profileLaunch;
  const definition = {
    name: "example",
    identity: skill.identity,
    sha256: skill.sha256!,
    source: null,
  };
  await captureSkillPolicy(config, "claude", {
    home,
    nativeDefaults: ["example"],
    installation: { definitions: [definition], excludedIdentities: [] },
  });
  expect(config.skillSnapshot).toBeUndefined();
  const restricted = structuredClone(config);
  await captureSkillPolicy(restricted, "claude", {
    home,
    nativeDefaults: ["example"],
    installation: { definitions: [definition], excludedIdentities: [skill.identity] },
  });
  expect(restricted.profileLaunch).toBeUndefined();
  expect(await verifySkillSnapshot(restricted)).toEqual([]);
  await captureSkillPolicy(config, "claude", {
    home,
    nativeDefaults: ["example"],
    installation: { definitions: [definition], excludedIdentities: [] },
  });
  expect(await verifySkillSnapshot(restricted)).toEqual([]);
  const selected = structuredClone(config);
  selected.profileLaunch = {
    profile: {
      id: "selected",
      name: "Selected",
      provider: "claude",
      skillPolicy: { mode: "selected", skills: [skill.identity] },
    },
  };
  await expect(
    captureSkillPolicy(selected, "claude", {
      home,
      installation: { definitions: [definition], excludedIdentities: [skill.identity] },
    }),
  ).rejects.toThrow("unavailable");
});

it("does not admit unshared personal packages and refuses missing canonical contents", async () => {
  const { home, skill, config } = await setup();
  delete config.profileLaunch;
  await captureSkillPolicy(config, "claude", {
    home,
    nativeDefaults: ["example"],
    installation: { definitions: [], excludedIdentities: [] },
  });
  expect(await verifySkillSnapshot(config)).toEqual([]);
  await expect(
    captureSkillPolicy(config, "claude", {
      home,
      installation: {
        definitions: [
          { name: "example", identity: skill.identity, sha256: "0".repeat(64), source: null },
        ],
        excludedIdentities: [],
      },
    }),
  ).rejects.toThrow("verified shared content");
  await expect(
    captureSkillPolicy(config, "unknown", {
      home,
      installation: { definitions: [], excludedIdentities: [skill.identity] },
    }),
  ).rejects.toThrow("no verified");
});
