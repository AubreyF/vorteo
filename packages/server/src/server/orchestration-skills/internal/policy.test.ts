import { chmod, mkdtemp, mkdir, writeFile, rm, cp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureSkillPolicy, verifySkillSnapshot } from "./policy";
import { codexSkillFilter } from "./codex-policy";
import { inventorySkills } from "./inventory";
import type { AgentSessionConfig } from "../../agent/agent-sdk-types";

const directories: string[] = [];
// Resume checks read the default home folder; give each test an empty one so the
// developer's own skills, plugins and commands never affect the result.
beforeEach(async () => {
  const userHome = await mkdtemp(path.join(os.tmpdir(), "skill-policy-user-"));
  directories.push(userHome);
  vi.spyOn(os, "homedir").mockReturnValue(userHome);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-policy-"));
  directories.push(home);
  // Stops the project folder walk here instead of at the filesystem root.
  await mkdir(path.join(home, ".git"));
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
it("maps native Codex paths to an explicit session allowlist", async () => {
  const selectedDirectory = path.resolve("selected");
  const selectedPath = path.join(selectedDirectory, "SKILL.md");
  const otherPath = path.resolve("other", "SKILL.md");
  const snapshot = {
    capturedAt: "now",
    provider: "codex",
    skills: [{ identity: "one", name: "same-name", path: selectedDirectory, sha256: "hash" }],
  };
  expect(
    await codexSkillFilter(snapshot, [
      { name: "same-name", path: selectedPath },
      { name: "same-name", path: otherPath },
    ]),
  ).toEqual([
    { path: selectedPath, enabled: true },
    { path: otherPath, enabled: false },
  ]);
  await expect(codexSkillFilter(snapshot, [])).rejects.toThrow("did not discover");
});
it("accepts an identical provider skill copy from an account's own Codex home", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-account-skills-"));
  directories.push(home);
  const hostCopy = path.join(home, ".codex/skills/.system/imagegen");
  const accountCopy = path.join(home, "codex-accounts/one/skills/.system/imagegen");
  const changedCopy = path.join(home, "codex-accounts/two/skills/.system/imagegen");
  await mkdir(hostCopy, { recursive: true });
  await writeFile(path.join(hostCopy, "SKILL.md"), "---\nname: imagegen\ndescription: x\n---\n");
  await cp(hostCopy, accountCopy, { recursive: true });
  await cp(hostCopy, changedCopy, { recursive: true });
  await writeFile(path.join(changedCopy, "extra.md"), "Different content");
  const skill = (await inventorySkills({ home })).skills.find((item) => item.name === "imagegen")!;
  const snapshot = {
    capturedAt: "now",
    provider: "codex",
    skills: [{ identity: skill.identity, name: "imagegen", path: hostCopy, sha256: skill.sha256! }],
  };
  const accountPath = path.join(accountCopy, "SKILL.md");
  const changedPath = path.join(changedCopy, "SKILL.md");
  expect(
    await codexSkillFilter(snapshot, [
      { name: "imagegen", path: accountPath },
      { name: "openai-docs", path: path.join(home, "other/SKILL.md") },
    ]),
  ).toEqual([
    { path: accountPath, enabled: true },
    { path: path.join(home, "other/SKILL.md"), enabled: false },
  ]);
  await expect(
    codexSkillFilter(snapshot, [{ name: "imagegen", path: changedPath }]),
  ).rejects.toThrow("did not discover");
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

it("launches restricted sessions when the provider lists defaults without packages", async () => {
  const { home, skill, config } = await setup();
  delete config.profileLaunch;
  const definition = {
    name: "example",
    identity: skill.identity,
    sha256: skill.sha256!,
    source: null,
  };
  const personal = path.join(home, ".claude/skills/unshared");
  await mkdir(personal, { recursive: true });
  await writeFile(path.join(personal, "SKILL.md"), "---\nname: unshared\ndescription: t\n---\nT");
  await captureSkillPolicy(config, "claude", {
    home,
    nativeDefaults: ["example", "unshared", "claude-api", "simplify", "synced", "tools:lint"],
    // Only skills Claude labels as bundled are kept; a name an observed package uses, such as
    // the unshared personal skill, and plugin-qualified names never are.
    providerBuiltins: async () => ["claude-api", "simplify", "unshared", "tools:lint"],
    installation: { definitions: [definition], excludedIdentities: [] },
  });
  expect(await verifySkillSnapshot(config)).toEqual(["example", "claude-api", "simplify"]);
  const shadow = path.join(home, ".claude/skills/simplify");
  await mkdir(shadow, { recursive: true });
  await writeFile(path.join(shadow, "SKILL.md"), "---\nname: simplify\ndescription: t\n---\nT");
  expect(await verifySkillSnapshot(config)).toEqual(["example", "claude-api"]);
});

async function bundledSetup() {
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
    nativeDefaults: ["example", "claude-api", "simplify"],
    providerBuiltins: async () => ["claude-api", "simplify"],
    installation: { definitions: [definition], excludedIdentities: ["another-identity"] },
  });
  return { home, config, account: path.join(home, "account") };
}
async function writeSkill(directory: string, name: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: t\n---\nT`);
}

it("turns off a built-in name claimed later by a plugin in the account's config folder", async () => {
  const { config, account } = await bundledSetup();
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual([
    "example",
    "claude-api",
    "simplify",
  ]);
  // Claude's allowlist would match the plugin skill "tools:simplify" by its suffix.
  await writeSkill(path.join(account, "plugins/cache/market/tools/1.0.0/skills/s"), "simplify");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual([
    "example",
    "claude-api",
  ]);
  // Marketplace plugins load in place without a cache copy.
  await writeSkill(
    path.join(account, "plugins/marketplaces/official/plugins/api/skills/a"),
    "claude-api",
  );
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual(["example"]);
});

it("does not refuse a resume because the account folder has a same-named copy of a package", async () => {
  const { config, account } = await bundledSetup();
  // Synced account skills often share a name with a shared package; only built-in names
  // are checked against the account folder.
  await writeSkill(path.join(account, "skills/synced/example"), "example");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual([
    "example",
    "claude-api",
    "simplify",
  ]);
});

it("turns off a built-in name claimed later by frontmatter in the account's skill folder", async () => {
  const { config, account } = await bundledSetup();
  await writeSkill(path.join(account, "skills/api-helper"), "claude-api");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual([
    "example",
    "simplify",
  ]);
});

it("reads the claimed name of a skill the inventory could not fully inspect", async () => {
  const { config, account } = await bundledSetup();
  // A symlinked file stops the package read, so inventory records only the folder name.
  const linked = path.join(account, "skills/helper");
  await writeSkill(linked, "simplify");
  await symlink(path.join(linked, "SKILL.md"), path.join(linked, "linked.md"));
  // More files than a package may hold has the same effect.
  const large = path.join(account, "skills/large");
  await writeSkill(large, "claude-api");
  for (let index = 0; index < 257; index++)
    await writeFile(path.join(large, `file-${index}.txt`), "x");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual(["example"]);
});

it("keeps no built-ins when a skill's frontmatter cannot be read", async () => {
  const { config, account } = await bundledSetup();
  const unreadable = path.join(account, "skills/locked");
  await writeSkill(unreadable, "other");
  await chmod(path.join(unreadable, "SKILL.md"), 0o000);
  try {
    expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual(["example"]);
  } finally {
    await chmod(path.join(unreadable, "SKILL.md"), 0o644);
  }
});

it("turns off built-in names claimed in the account's synced skill layout", async () => {
  const { config, account } = await bundledSetup();
  await writeSkill(path.join(account, "skills/synced/helper"), "simplify");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual([
    "example",
    "claude-api",
  ]);
});

it("keeps no built-ins when a folder inside a plugin root cannot be read", async () => {
  const { config, account } = await bundledSetup();
  const locked = path.join(account, "plugins/marketplaces/market/plugins/locked");
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o000);
  try {
    expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual(["example"]);
  } finally {
    await chmod(locked, 0o755);
  }
});

it("turns off built-in names claimed by custom commands added after launch", async () => {
  const { home, config, account } = await bundledSetup();
  // Claude lists custom commands as skills and its allowlist matches them by name.
  await mkdir(path.join(home, ".claude/commands"), { recursive: true });
  await writeFile(path.join(home, ".claude/commands/simplify.md"), "Simplify");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual([
    "example",
    "claude-api",
  ]);
  // A nested plugin command is listed as "group:claude-api" and matches by suffix.
  const commands = path.join(account, "plugins/marketplaces/market/plugins/tools/commands/group");
  await mkdir(commands, { recursive: true });
  await writeFile(path.join(commands, "claude-api.md"), "Call the API");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual(["example"]);
});

it("turns off built-in names claimed by commands in the user's home folder", async () => {
  const { config } = await bundledSetup();
  const userHome = os.homedir();
  expect(path.basename(userHome)).toMatch(/^skill-policy-user-/);
  await mkdir(path.join(userHome, ".claude/commands"), { recursive: true });
  await writeFile(path.join(userHome, ".claude/commands/claude-api.md"), "Call the API");
  expect(await verifySkillSnapshot(config)).toEqual(["example", "simplify"]);
});

it("keeps no built-ins when an account skill folder cannot be read", async () => {
  const { config, account } = await bundledSetup();
  await mkdir(account, { recursive: true });
  // A file where the skills folder belongs fails to read with ENOTDIR.
  await writeFile(path.join(account, "skills"), "not a directory");
  expect(await verifySkillSnapshot(config, { claudeConfigDir: account })).toEqual(["example"]);
});

it("resumes a snapshot recorded before built-ins existed with packaged skills only", async () => {
  const { config } = await bundledSetup();
  delete config.skillSnapshot!.builtins;
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
});

it("leaves built-ins out of selected-only profiles", async () => {
  const { home, skill, config } = await setup();
  await captureSkillPolicy(config, "claude", {
    home,
    providerBuiltins: async () => ["claude-api"],
  });
  expect(config.profileLaunch?.skillSnapshot?.builtins).toBeUndefined();
  expect(await verifySkillSnapshot(config)).toEqual([skill.name]);
});

it("treats a package's folder name as a claim on a built-in name", async () => {
  const { home, skill, config } = await setup();
  delete config.profileLaunch;
  const definition = {
    name: "example",
    identity: skill.identity,
    sha256: skill.sha256!,
    source: null,
  };
  const renamed = path.join(home, ".claude/skills/dataviz");
  await mkdir(renamed, { recursive: true });
  await writeFile(path.join(renamed, "SKILL.md"), "---\nname: charts\ndescription: t\n---\nT");
  await captureSkillPolicy(config, "claude", {
    home,
    nativeDefaults: ["example", "charts", "dataviz"],
    providerBuiltins: async () => ["dataviz"],
    installation: { definitions: [definition], excludedIdentities: [] },
  });
  expect(await verifySkillSnapshot(config)).toEqual(["example"]);
});
