import { SkillLibrary } from "../../orchestration-skills/internal/library.js";
import type { InstallationSkill } from "@getpaseo/protocol/skill-library";
import {
  collectInstallationSkills,
  mergeInstallationSkills,
  installationSkillsSettled,
  projectInstallationSkills,
} from "./skill-catalog.js";
import { InstallationSkillPackages } from "./skill-packages.js";
import type { SkillFiles } from "../../orchestration-skills/internal/inventory.js";
import { packageHash } from "../../orchestration-skills/internal/inventory.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createSettingsJournal, installationHostInstructions } from "./runtime.js";
import { nativeHostInstallationInstructions } from "./instructions.js";
import { SettingsEnvironmentFake } from "./fakes.js";
import { InstallationSettingsService, SettingsBackupSchema } from "./service.js";

test("private filesystem journal preserves migration, edits, and recoverable policy backups", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "installation-settings-"));
  try {
    const host = new SettingsEnvironmentFake("host");
    const container = new SettingsEnvironmentFake("container");
    host.config.appendSystemPrompt = "Host policy";
    container.config.appendSystemPrompt = "Container policy";
    const journal = createSettingsJournal(directory);
    const service = new InstallationSettingsService(journal, [host, container]);
    await service.reconcile();
    const restored = new InstallationSettingsService(createSettingsJournal(directory), [
      host,
      container,
    ]);
    expect(restored.snapshot()).toEqual(service.snapshot());
    await restored.update({
      expectedRevision: 1,
      settings: { appendSystemPrompt: "Shared policy" },
    });
    await restored.reconcile();
    expect(journal.read()).toEqual(restored.snapshot());
    const backups = path.join(directory, "backups");
    const files = readdirSync(backups);
    expect(files).toHaveLength(4);
    const receipts = files.map((file) =>
      SettingsBackupSchema.parse(JSON.parse(readFileSync(path.join(backups, file), "utf8"))),
    );
    const migration = receipts.find((receipt) => receipt.reason === "initial-migration");
    expect(migration?.observations.host.appendSystemPrompt).toBe("Host policy");
    expect(migration?.observations.container.appendSystemPrompt).toBe("Container policy");
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(backups).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(directory, "state.json")).mode & 0o777).toBe(0o600);
      for (const file of files) expect(statSync(path.join(backups, file)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(directory).sort()).toEqual(["backups", "skill-packages", "state.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt persisted state fails closed without replacing it", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "installation-settings-"));
  try {
    const file = path.join(directory, "state.json");
    writeFileSync(file, "invalid JSON", { mode: 0o600 });
    expect(() => createSettingsJournal(directory).read()).toThrow();
    expect(readFileSync(file, "utf8")).toBe("invalid JSON");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("host authority uses the installer skill path outside coordinator state", () => {
  const stateDir = "/private/installation/state/coordinator";
  const expected = nativeHostInstallationInstructions(
    "/private/installation/skills/installation-maintenance/SKILL.md",
  );
  expect(
    installationHostInstructions({
      stateDir,
      ownerPasswordFile: "/private/installation/owner-password",
    }),
  ).toBe(expected);
  expect(installationHostInstructions({ stateDir })).toBe(expected);
});

test("shared skill storage retains verified content privately without environment paths", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "installation-skill-packages-"));
  try {
    const files = new Map([
      [
        "SKILL.md",
        Buffer.from("---\nname: example\ndescription: Example\n---\nShared instructions\n"),
      ],
    ]);
    const pkg = {
      name: "example",
      source: null,
      sha256: packageHash(files),
      files: [
        { path: "SKILL.md", content: files.get("SKILL.md")!.toString("base64"), executable: false },
      ],
    };
    const store = new InstallationSkillPackages(directory);
    const definition = store.save(pkg);
    expect(definition).toEqual({
      name: pkg.name,
      source: null,
      sha256: pkg.sha256,
      identity: `content:${pkg.sha256}`,
    });
    expect(JSON.stringify(definition)).not.toContain("Shared instructions");
    expect(new InstallationSkillPackages(directory).read(definition)).toEqual(pkg);
    expect(() => store.read({ ...definition, identity: "different" })).toThrow(
      "conflicting identity",
    );
    expect(store.save({ ...pkg, name: "alias" })).toEqual({ ...definition, name: "alias" });
    expect(readdirSync(directory)).toEqual([`${pkg.sha256}.json`]);
    const file = path.join(directory, `${pkg.sha256}.json`);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    writeFileSync(file, "corrupt retained package");
    expect(() => store.read(definition)).toThrow();
    expect(() => store.save(pkg)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("corrupt retained package");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared skill collection preserves both environments and reports conflicting versions", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "installation-skill-catalog-"));
  try {
    const store = new InstallationSkillPackages(path.join(directory, "packages"));
    const observations: Record<string, InstallationSkill[]> = {};
    for (const environment of ["host", "container"]) {
      const home = path.join(directory, environment);
      for (const name of ["shared", environment]) {
        const target = path.join(home, ".agents/skills", name);
        mkdirSync(target, { recursive: true });
        writeFileSync(
          path.join(target, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${environment}\n---\n${environment} instructions\n`,
        );
        writeFileSync(
          path.join(target, ".vorteo-skill-source.json"),
          JSON.stringify({
            repository: "example/skills",
            directory: name,
            revision: environment === "host" ? "a".repeat(40) : "b".repeat(40),
          }),
        );
      }
      const library = new SkillLibrary(path.join(home, "state"), home);
      observations[environment] = await collectInstallationSkills(
        { readSkillLibrary: (request) => library.read(request) },
        store,
      );
    }
    const merged = mergeInstallationSkills(observations);
    expect(merged.definitions.map((entry) => entry.identity)).toEqual([
      "github:example/skills/container",
      "github:example/skills/host",
      "github:example/skills/shared",
    ]);
    expect(merged.conflicts).toEqual([
      {
        identity: "github:example/skills/shared",
        candidates: {
          host: [observations.host.find((entry) => entry.name === "shared")],
          container: [observations.container.find((entry) => entry.name === "shared")],
        },
      },
    ]);
    expect(readdirSync(path.join(directory, "packages"))).toHaveLength(4);
    expect(JSON.stringify(merged)).not.toContain(directory);
    for (const definitions of Object.values(observations))
      for (const definition of definitions)
        expect(store.read(definition).sha256).toBe(definition.sha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared skill projection installs verified content and provider discovery without repeated writes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "installation-skill-projection-"));
  try {
    const store = new InstallationSkillPackages(path.join(directory, "packages"));
    const files = new Map([
      ["SKILL.md", Buffer.from("---\nname: shared\ndescription: Shared\n---\nInstructions\n")],
    ]);
    const definition = store.save({
      name: "shared",
      source: null,
      sha256: packageHash(files),
      files: [
        { path: "SKILL.md", content: files.get("SKILL.md")!.toString("base64"), executable: false },
      ],
    });
    for (const environment of ["host", "container"]) {
      const home = path.join(directory, environment);
      const library = new SkillLibrary(path.join(home, "state"), home);
      const port = {
        readSkillLibrary: library.read.bind(library),
        changeSkillLibrary: library.change.bind(library),
      };
      expect(await installationSkillsSettled(port, [definition])).toBe(false);
      await projectInstallationSkills(port, [definition], store);
      expect(await installationSkillsSettled(port, [definition])).toBe(true);
      const history = await library.read({ kind: "audit" });
      await projectInstallationSkills(port, [definition], store);
      expect(await library.read({ kind: "audit" })).toEqual(history);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical settings refuse skill references without verified stored packages", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "installation-skill-reference-"));
  try {
    const journal = createSettingsJournal(directory);
    const service = new InstallationSettingsService(journal, [
      new SettingsEnvironmentFake("host"),
      new SettingsEnvironmentFake("container"),
    ]);
    await service.reconcile();
    const previous = service.snapshot();
    await expect(
      service.update({
        expectedRevision: previous.revision,
        settings: {
          skillLibrary: [
            {
              name: "missing",
              source: null,
              sha256: "a".repeat(64),
              identity: `content:${"a".repeat(64)}`,
            },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(service.snapshot()).toEqual(previous);
    expect(journal.read()).toEqual(previous);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pinned skill preparation retains reviewable bytes and modes without changing canonical settings", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "installation-skill-prepare-"));
  try {
    const journal = createSettingsJournal(directory);
    const service = new InstallationSettingsService(journal, [new SettingsEnvironmentFake("host")]);
    await service.reconcile();
    const original = service.snapshot();
    const source = {
      repository: "owner/repository",
      revision: "a".repeat(40),
      directory: "skills/example",
    };
    const files: SkillFiles = new Map([
      ["SKILL.md", Buffer.from("---\nname: example\ndescription: Example\n---\nReview me\n")],
      ["run.sh", Buffer.from("echo example\n")],
    ]);
    files.executables = new Set(["run.sh"]);
    const download = vi.fn(async () => files);
    const store = new InstallationSkillPackages(path.join(directory, "skill-packages"));
    const prepared = await store.prepare(source, download);
    expect(download).toHaveBeenCalledWith(source);
    expect(prepared.definition.identity).toBe("github:owner/repository/skills/example");
    expect(prepared.package.files.find((file) => file.path === "run.sh")).toEqual({
      path: "run.sh",
      content: files.get("run.sh")!.toString("base64"),
      executable: true,
    });
    expect(store.read(prepared.definition)).toEqual(prepared.package);
    expect(service.snapshot()).toEqual(original);
    expect(journal.read()).toEqual(original);
    await expect(store.prepare({ ...source, revision: "main" }, download)).rejects.toThrow();
    expect(download).toHaveBeenCalledTimes(1);
    await service.update({
      expectedRevision: original.revision,
      settings: { ...original.settings, skillLibrary: [prepared.definition] },
    });
    expect(service.snapshot().settings?.skillLibrary).toEqual([prepared.definition]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
