import { test, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, symlink, realpath, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  digestBootstrapArtifact,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bootstrap-artifact-")));
  roots.push(root);
  await mkdir(path.join(root, "release"), { mode: 0o700 });
  await writeFile(path.join(root, "release", "entry.js"), "export {};", { mode: 0o600 });
  return { root, release: path.join(root, "release") };
}

test("artifact approval binds dependencies, executable permissions and internal links", async () => {
  const { release } = await fixture();
  const original = await digestBootstrapArtifact(release);
  expect(await digestBootstrapArtifact(release)).toBe(original);
  await mkdir(path.join(release, "dependencies"));
  await writeFile(path.join(release, "dependencies", "package.js"), "dependency", { mode: 0o600 });
  const dependency = await digestBootstrapArtifact(release);
  expect(dependency).not.toBe(original);
  await chmod(path.join(release, "entry.js"), 0o700);
  const executable = await digestBootstrapArtifact(release);
  expect(executable).not.toBe(dependency);
  await symlink("dependencies/package.js", path.join(release, "linked.js"));
  expect(await digestBootstrapArtifact(release)).not.toBe(executable);
});

test("artifact validation rejects links escaping the release and writable dependencies", async () => {
  const { root, release } = await fixture();
  await writeFile(path.join(root, "outside.js"), "outside");
  await symlink("../outside.js", path.join(release, "escape.js"));
  await expect(digestBootstrapArtifact(release)).rejects.toThrow("outside");
  await rm(path.join(release, "escape.js"));
  await chmod(path.join(release, "entry.js"), 0o666);
  await expect(digestBootstrapArtifact(release)).rejects.toThrow("writable");
});

test("artifact validation rejects substituted release roots and external hard links", async () => {
  const { root, release } = await fixture();
  const alias = path.join(root, "alias");
  await symlink(release, alias);
  await expect(digestBootstrapArtifact(alias)).rejects.toThrow("canonical");
  await link(path.join(release, "entry.js"), path.join(root, "outside.js"));
  await expect(digestBootstrapArtifact(release)).rejects.toThrow("hard-linked");
});

test("protected paths cannot overlap writable guest mounts through aliases or ancestry", async () => {
  const { root, release } = await fixture();
  const guest = path.join(root, "guest");
  await mkdir(guest);
  await expect(assertBootstrapPathsProtected([release], [guest])).resolves.toBeUndefined();
  await expect(assertBootstrapPathsProtected([release], [root])).rejects.toThrow("container mount");
  await expect(assertBootstrapPathsProtected([root], [guest])).rejects.toThrow("container mount");
  const alias = path.join(root, "alias");
  await symlink(release, alias);
  await expect(assertBootstrapPathsProtected([alias], [release])).rejects.toThrow(
    "container mount",
  );
  await expect(
    assertBootstrapPathsProtected([release], [path.join(root, "missing")]),
  ).rejects.toThrow();
});
