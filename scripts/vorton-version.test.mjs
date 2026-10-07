import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/vorton-version.mjs");
test("commit versions advance once, preserve staging, and synchronize lock metadata", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "vorton-version-"));
  const run = (bin, args) =>
    execFileSync(bin, args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
  const git = (...args) => run("git", args);
  const write = (file, value) =>
    writeFileSync(path.join(cwd, file), `${JSON.stringify(value, null, 2)}\n`);
  const read = (file) => JSON.parse(readFileSync(path.join(cwd, file), "utf8"));
  const stageChangelog = (version) => {
    writeFileSync(
      path.join(cwd, "VORTEO_CHANGELOG.md"),
      `# Vorteo changelog\n\n## ${version} - 2026-10-07\n\n### Maintenance\n\n- Update the fixture\n`,
    );
    git("add", "VORTEO_CHANGELOG.md");
  };
  try {
    mkdirSync(path.join(cwd, "packages/a"), { recursive: true });
    git("init");
    git("config", "user.name", "Version test");
    git("config", "user.email", "version@example.invalid");
    git("config", "core.hooksPath", "/dev/null");
    write("package.json", {
      name: "root",
      private: true,
      version: "0.7.2",
      workspaces: ["packages/a"],
    });
    write("packages/a/package.json", { name: "a", version: "0.7.2" });
    write("package-lock.json", {
      // Real monorepo lockfiles exceed Node's default subprocess buffer.
      fixturePadding: "x".repeat(1024 * 1024),
      version: "0.7.2",
      packages: { "": { version: "0.7.2" }, "packages/a": { version: "0.7.2" } },
    });
    git("add", ".");
    git("commit", "-m", "fixture");
    git("config", "core.hooksPath", ".git/hooks");
    const hook = path.join(cwd, ".git/hooks/pre-commit");
    writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${script}" --hook\n`);
    chmodSync(hook, 0o755);
    const unchangedIndex = git("diff", "--cached");
    assert.throws(() => run(process.execPath, [script, "--hook"]), /entry for every commit/);
    assert.equal(git("diff", "--cached"), unchangedIndex);
    assert.equal(read("package.json").version, "0.7.2");
    stageChangelog("0.7.2-vorteo.100");
    const validNotes = readFileSync(path.join(cwd, "VORTEO_CHANGELOG.md"), "utf8");
    for (const invalid of [
      validNotes.replace("vorteo.100", "vorteo.99"),
      validNotes.replace("- Update the fixture", ""),
      validNotes.replace("2026-10-07", "undated"),
    ]) {
      writeFileSync(path.join(cwd, "VORTEO_CHANGELOG.md"), invalid);
      git("add", "VORTEO_CHANGELOG.md");
      writeFileSync(path.join(cwd, "VORTEO_CHANGELOG.md"), validNotes);
      assert.throws(() => run(process.execPath, [script, "--hook"]), /nonempty top/);
      assert.equal(read("package.json").version, "0.7.2");
    }
    git("add", "VORTEO_CHANGELOG.md");
    run(process.execPath, [script, "--hook"]);
    assert.equal(read("package.json").version, "0.7.2-vorteo.100");
    run(process.execPath, [script, "--hook"]);
    run(process.execPath, [script, "--check"]);
    assert.equal(read("package.json").version, "0.7.2-vorteo.100");
    git("commit", "-m", "first");
    writeFileSync(path.join(cwd, "unrelated.txt"), "leave me unstaged");
    assert.throws(() => run(process.execPath, [script, "--hook"]), /entry for every commit/);
    stageChangelog("0.7.2-vorteo.101");
    run(process.execPath, [script, "--hook"]);
    assert.equal(read("package.json").version, "0.7.2-vorteo.101");
    assert.equal(read("package-lock.json").packages["packages/a"].version, "0.7.2-vorteo.101");
    assert.ok(!git("diff", "--cached", "--name-only").includes("unrelated.txt"));
    const pkg = read("packages/a/package.json");
    pkg.description = "unstaged change";
    write("packages/a/package.json", pkg);
    const index = git("diff", "--cached");
    assert.throws(() => run(process.execPath, [script, "--hook"]), /Stage or stash/);
    assert.equal(git("diff", "--cached"), index);
    git("add", "packages/a/package.json");
    git("commit", "-m", "second");
    const root = read("package.json");
    root.version = "0.7.3";
    write("package.json", root);
    run(process.execPath, [script]);
    assert.equal(read("package.json").version, "0.7.3-vorteo.102");
    root.version = "0.9.0-beta.2";
    write("package.json", root);
    run(process.execPath, [script]);
    assert.equal(read("package.json").version, "0.9.0-beta.2.vorteo.102");
    git("add", "package.json", "packages/a/package.json", "package-lock.json");
    stageChangelog("0.9.0-beta.2.vorteo.102");
    git("commit", "-m", "beta base");
    stageChangelog("0.9.0-beta.2.vorteo.103");
    run(process.execPath, [script, "--hook"]);
    assert.equal(read("package.json").version, "0.9.0-beta.2.vorteo.103");
    root.version = "0.9.0-beta.1";
    write("package.json", root);
    assert.throws(() => run(process.execPath, [script]), /cannot decrease/);
    root.version = "0.9.0-beta.3";
    write("package.json", root);
    run(process.execPath, [script]);
    assert.equal(read("package.json").version, "0.9.0-beta.3.vorteo.103");
    root.version = "0.9.0";
    write("package.json", root);
    run(process.execPath, [script]);
    assert.equal(read("package.json").version, "0.9.0-vorteo.103");
    git("add", "package.json", "packages/a/package.json", "package-lock.json");
    stageChangelog("0.9.0-vorteo.103");
    git("commit", "-m", "stable base");
    root.version = "0.9.0-beta.3";
    write("package.json", root);
    assert.throws(() => run(process.execPath, [script]), /cannot decrease/);
    root.version = "0.7.1";
    write("package.json", root);
    assert.throws(() => run(process.execPath, [script]), /cannot decrease/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const versions of [
  ["0.7.2-vorton.11", "0.7.2-vorteo.23", "0.7.2-vorteo.100"],
  ["0.11.0-beta.3.vorteo.17", "0.9.0-beta.2.vorteo.46", "0.11.0-beta.3.vorteo.100"],
  ["0.9.0-beta.2.vorton.100", "0.9.0-beta.2.vorteo.123", "0.9.0-beta.2.vorteo.124"],
  ["0.9.0-beta.2.vorteo.100", "0.7.2-vorteo.129", "0.9.0-beta.2.vorteo.130"],
]) {
  test(`merge versions advance beyond both parents: ${versions.join(", ")}`, () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "vorton-merge-version-"));
    const run = (bin, args) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: "pipe" });
    const git = (...args) => run("git", args);
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
    const version = () => JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).version;
    try {
      git("init", "-b", "task");
      git("config", "user.name", "Version test");
      git("config", "user.email", "version@example.invalid");
      git("config", "core.hooksPath", "/dev/null");
      writeVersion(versions[0]);
      git("add", ".");
      git("commit", "-m", "task fixture");
      git("checkout", "-b", "incoming");
      writeVersion(versions[1]);
      git("add", ".");
      git("commit", "-m", "incoming fixture");
      git("checkout", "task");
      git("merge", "--no-ff", "--no-commit", "incoming");
      writeVersion(versions[0]);
      run(process.execPath, [script]);
      assert.equal(version(), versions[2]);
      writeFileSync(
        path.join(cwd, "VORTEO_CHANGELOG.md"),
        `# Vorteo changelog\n\n## ${versions[2]} - 2026-10-07\n\n### Maintenance\n\n- Merge upstream changes\n`,
      );
      git("add", ".");
      run(process.execPath, [script, "--hook"]);
      run(process.execPath, [script, "--check"]);
      assert.equal(version(), versions[2]);
      assert.equal(
        JSON.parse(readFileSync(path.join(cwd, "package-lock.json"), "utf8")).version,
        version(),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
