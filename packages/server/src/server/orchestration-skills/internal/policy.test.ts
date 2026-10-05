import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
  await captureSkillPolicy(config, "claude", home);
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
  const second = structuredClone(config);
  second.profileLaunch!.profile.skillPolicy = { mode: "none" };
  await captureSkillPolicy(second, "claude", home);
  expect(await verifySkillSnapshot(second)).toEqual([]);
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
  await writeFile(path.join(directory, "script.sh"), "Changed code");
  await expect(verifySkillSnapshot(config)).rejects.toThrow("changed after launch");
});
it("refuses unsupported providers and missing selected identities", async () => {
  const { home, config } = await setup();
  await expect(captureSkillPolicy(config, "unknown", home)).rejects.toThrow("no verified");
  config.profileLaunch!.profile.skillPolicy = { mode: "selected", skills: ["unavailable"] };
  await expect(captureSkillPolicy(config, "claude", home)).rejects.toThrow("unavailable");
});
it("excludes equivalent packages without relying on display names", async () => {
  const { home, config, skill } = await setup();
  config.profileLaunch!.profile.skillPolicy = {
    mode: "inherit",
    include: [],
    exclude: [skill.identity],
  };
  await captureSkillPolicy(config, "claude", home);
  expect(await verifySkillSnapshot(config)).toEqual([]);
});
it("maps native Codex paths to an explicit session allowlist", () => {
  const snapshot = {
    capturedAt: "now",
    provider: "codex",
    skills: [{ identity: "one", name: "same-name", path: "/selected", sha256: "hash" }],
  };
  expect(
    codexSkillFilter(snapshot, [
      { name: "same-name", path: "/selected/SKILL.md" },
      { name: "same-name", path: "/other/SKILL.md" },
    ]),
  ).toEqual([
    { path: "/selected/SKILL.md", enabled: true },
    { path: "/other/SKILL.md", enabled: false },
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
  await captureSkillPolicy(config, "claude", home, []);
  expect(await verifySkillSnapshot(config)).toEqual([]);
  config.profileLaunch!.profile.skillPolicy = {
    mode: "inherit",
    include: [skill.identity],
    exclude: [],
  };
  await captureSkillPolicy(config, "claude", home, []);
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
});
