import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/vorton-version.mjs");

function repository(prefix) {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  const run = (bin, args) =>
    execFileSync(bin, args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
  const git = (...args) => run("git", args);
  const write = (file, value) =>
    writeFileSync(path.join(cwd, file), `${JSON.stringify(value, null, 2)}\n`);
  const read = (file) => JSON.parse(readFileSync(path.join(cwd, file), "utf8"));
  const stageChangelog = (label, text = "Update the fixture") => {
    writeFileSync(
      path.join(cwd, "VORTEO_CHANGELOG.md"),
      `# Vorteo changelog\n\n## ${label} - 2026-10-30\n\n### Maintenance\n\n- ${text}\n`,
    );
    git("add", "VORTEO_CHANGELOG.md");
  };
  const hook = (mode = "--hook") => run(process.execPath, [script, mode]);
  return { cwd, run, git, write, read, stageChangelog, hook };
}

test("commits keep the prepared version, stage synchronized manifests and need an entry", () => {
  const { cwd, git, write, read, stageChangelog, hook } = repository("vorteo-version-");
  try {
    mkdirSync(path.join(cwd, "packages/a"), { recursive: true });
    git("init");
    git("config", "user.name", "Version test");
    git("config", "user.email", "version@example.invalid");
    git("config", "core.hooksPath", "/dev/null");
    const legacy = "0.11.0-beta.3.vorteo.957";
    write("package.json", {
      name: "root",
      private: true,
      version: legacy,
      workspaces: ["packages/a"],
    });
    write("packages/a/package.json", { name: "a", version: legacy });
    write("package-lock.json", {
      // Real monorepo lockfiles exceed Node's default subprocess buffer.
      fixturePadding: "x".repeat(1024 * 1024),
      version: legacy,
      packages: { "": { version: legacy }, "packages/a": { version: legacy } },
    });
    git("add", ".");
    git("commit", "-m", "fixture");
    git("config", "core.hooksPath", ".git/hooks");
    const hookFile = path.join(cwd, ".git/hooks/pre-commit");
    writeFileSync(hookFile, `#!/bin/sh\nexec "${process.execPath}" "${script}" --hook\n`);
    chmodSync(hookFile, 0o755);

    // A legacy counter version is no longer accepted for new commits.
    stageChangelog("Unreleased");
    assert.throws(() => hook(), /not a Vorteo version/);

    // The transition sets a calendar version; its entry is headed by that version.
    const root = read("package.json");
    root.version = "26.10.3000";
    write("package.json", root);
    assert.throws(() => hook(), /headed "## 26\.10\.3000/);
    stageChangelog("26.10.3000", "Switch to calendar versions");
    const validNotes = readFileSync(path.join(cwd, "VORTEO_CHANGELOG.md"), "utf8");
    for (const invalid of [
      validNotes.replace("- Switch to calendar versions", ""),
      validNotes.replace("2026-10-30", "undated"),
    ]) {
      writeFileSync(path.join(cwd, "VORTEO_CHANGELOG.md"), invalid);
      git("add", "VORTEO_CHANGELOG.md");
      writeFileSync(path.join(cwd, "VORTEO_CHANGELOG.md"), validNotes);
      assert.throws(() => hook(), /nonempty top/);
    }
    git("add", "VORTEO_CHANGELOG.md");
    git("add", "package.json");
    hook();
    hook("--check");
    assert.equal(read("packages/a/package.json").version, "26.10.3000");
    assert.equal(read("package-lock.json").packages["packages/a"].version, "26.10.3000");
    git("commit", "-m", "calendar versions");

    // Later commits keep the version and add Unreleased entries.
    writeFileSync(path.join(cwd, "unrelated.txt"), "leave me unstaged");
    assert.throws(() => hook(), /entry for every commit \(## Unreleased\)/);
    stageChangelog("26.10.3000");
    assert.throws(() => hook(), /headed "## Unreleased/);
    stageChangelog("Unreleased");
    hook();
    assert.equal(read("package.json").version, "26.10.3000");
    assert.ok(!git("diff", "--cached", "--name-only").includes("unrelated.txt"));
    const pkg = read("packages/a/package.json");
    pkg.description = "unstaged change";
    write("packages/a/package.json", pkg);
    const index = git("diff", "--cached");
    assert.throws(() => hook(), /Stage or stash/);
    assert.equal(git("diff", "--cached"), index);
    git("add", "packages/a/package.json");
    git("commit", "-m", "second");

    // A version can never go backwards, even to a legacy one.
    for (const older of ["26.10.2900", legacy]) {
      root.version = older;
      write("package.json", root);
      assert.throws(() => hook("--sync"), /cannot go below|not a Vorteo version/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [task, incoming, label] of [
  ["26.10.3000", "26.10.3100", "Unreleased"],
  ["0.11.0-beta.3.vorteo.957", "26.10.3000", "Unreleased"],
]) {
  test(`a merge takes the newer version without a new release entry: ${task}, ${incoming}`, () => {
    const { cwd, run, git, stageChangelog, hook } = repository("vorteo-merge-version-");
    const writeVersion = (version) => {
      writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({ name: "root", version, workspaces: [] }),
      );
      writeFileSync(
        path.join(cwd, "package-lock.json"),
        JSON.stringify({ version, packages: { "": { version } } }),
      );
    };
    try {
      git("init", "-b", "task");
      git("config", "user.name", "Version test");
      git("config", "user.email", "version@example.invalid");
      git("config", "core.hooksPath", "/dev/null");
      writeVersion(task);
      git("add", ".");
      git("commit", "-m", "task fixture");
      git("checkout", "-b", "incoming");
      writeVersion(incoming);
      git("add", ".");
      git("commit", "-m", "incoming fixture");
      git("checkout", "task");
      git("merge", "--no-ff", "--no-commit", "incoming");
      writeVersion(task);
      if (task !== incoming && !task.includes("vorteo")) {
        assert.throws(() => run(process.execPath, [script]), /cannot go below/);
      }
      writeVersion(incoming);
      stageChangelog(label, "Merge upstream changes");
      git("add", ".");
      hook();
      hook("--check");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
