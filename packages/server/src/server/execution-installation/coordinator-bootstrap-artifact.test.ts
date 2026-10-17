import { test, expect, afterEach, vi } from "vitest";
import * as nativeFs from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  symlink,
  realpath,
  rm,
  link,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  digestBootstrapArtifact,
  inspectBootstrapArtifact,
  assertBootstrapPathsProtected,
  verifyBootstrapReleaseArtifacts,
  inspectBootstrapReleaseArtifacts,
  verifyBootstrapPreparedDependency,
  verifyBootstrapPreparedCopySource,
} from "./coordinator-bootstrap-artifact.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

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

test("native CLI custody retains digest, mount and write-protection checks", async () => {
  const { root } = await fixture();
  const file = path.join(root, "native-cli");
  const bytes = "fixture executable";
  await writeFile(file, bytes, { mode: 0o700 });
  const pin = { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  await expect(verifyBootstrapPreparedDependency(pin, [], "host-or-root")).resolves.toBeUndefined();
  await expect(
    verifyBootstrapPreparedDependency({ ...pin, sha256: "0".repeat(64) }, [], "host-or-root"),
  ).rejects.toThrow("digest changed");
  await expect(verifyBootstrapPreparedDependency(pin, [root], "host-or-root")).rejects.toThrow(
    "writable container mount",
  );
  await chmod(file, 0o722);
  await expect(verifyBootstrapPreparedDependency(pin, [], "host-or-root")).rejects.toThrow(
    "writable by another account",
  );
  await expect(verifyBootstrapPreparedDependency(pin, [])).rejects.toThrow(
    "writable by another account",
  );
});

test("artifact digests preserve chunk boundaries and isolate concurrent scan buffers", async () => {
  const releases: string[] = [];
  for (const value of [17, 226]) {
    const { release } = await fixture();
    releases.push(release);
    await writeFile(path.join(release, "a-large.bin"), Buffer.alloc(65543, value), { mode: 0o600 });
    await writeFile(path.join(release, "b-short.bin"), Buffer.from([value]), { mode: 0o600 });
    await writeFile(path.join(release, "c-empty.bin"), Buffer.alloc(0), { mode: 0o600 });
  }
  // These digests come from the original implementation with a fresh buffer per file.
  const expected = [
    "135f9d42968d7943504510bfd14d6c141602b8981354c218f57e729a56863642",
    "9d9529f25aa872f72ad2c488c8db98522cfb0a5f641a7dc9d749cee29f40e523",
  ];
  for (const [index, release] of releases.entries()) {
    expect(await digestBootstrapArtifact(release)).toBe(expected[index]);
  }
  expect(await Promise.all(releases.map((release) => digestBootstrapArtifact(release)))).toEqual(
    expected,
  );
});

async function preparedReleaseFixture() {
  const { root, release } = await fixture();
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const node = path.join(root, "node");
  const configuration = path.join(root, "coordinator.json");
  const launcher = path.join(root, "launcher.plist");
  await writeFile(node, "fixture executable", { mode: 0o700 });
  await writeFile(configuration, "{}", { mode: 0o600 });
  await writeFile(launcher, "fixture launcher", { mode: 0o600 });
  await writeFile(
    path.join(release, ".installation-source.json"),
    JSON.stringify({ sourceCommit: "a".repeat(40) }),
    { mode: 0o600 },
  );
  const candidate = {
    sourceCommit: "a".repeat(40),
    directory: release,
    artifactSha256: await digestBootstrapArtifact(release),
    node: { path: node, sha256: digest("fixture executable") },
    entrypoint: { path: path.join(release, "entry.js"), sha256: digest("export {};") },
    configuration: { path: configuration, sha256: digest("{}") },
    launcher: { path: launcher, sha256: digest("fixture launcher") },
  };
  return { root, release, candidate, node, configuration };
}

test("prepared release binds external dependencies and its complete runtime tree", async () => {
  const { root, release, candidate, node, configuration } = await preparedReleaseFixture();
  await expect(verifyBootstrapReleaseArtifacts(candidate, [])).resolves.toBeUndefined();
  await expect(
    verifyBootstrapReleaseArtifacts({ ...candidate, sourceCommit: "b".repeat(40) }, []),
  ).rejects.toThrow("installation receipt");
  await expect(verifyBootstrapReleaseArtifacts(candidate, [root])).rejects.toThrow("mount");
  await chmod(node, 0o600);
  await expect(verifyBootstrapReleaseArtifacts(candidate, [])).rejects.toThrow("not executable");
  await chmod(node, 0o700);
  await writeFile(configuration, '{"changed":true}');
  await expect(verifyBootstrapReleaseArtifacts(candidate, [])).rejects.toThrow("digest changed");
  await writeFile(configuration, "{}");
  await expect(
    verifyBootstrapReleaseArtifacts({ ...candidate, entrypoint: candidate.node }, []),
  ).rejects.toThrow("outside");
  await writeFile(path.join(release, "dependency.js"), "new dependency", { mode: 0o600 });
  await expect(verifyBootstrapReleaseArtifacts(candidate, [])).rejects.toThrow("artifact changed");
});

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

test("artifact accepts only complete internal hard-link groups and binds their topology", async () => {
  const { root, release } = await fixture();
  const entry = path.join(release, "entry.js");
  const alias = path.join(release, "alias.js");
  await link(entry, alias);
  const linked = await digestBootstrapArtifact(release);
  expect(await digestBootstrapArtifact(release)).toBe(linked);
  const outside = path.join(root, "external.js");
  await link(entry, outside);
  await expect(digestBootstrapArtifact(release)).rejects.toThrow("escapes");
  await rm(outside);
  expect(await digestBootstrapArtifact(release)).toBe(linked);
  await rm(alias);
  await writeFile(alias, "export {};", { mode: 0o600 });
  expect(await digestBootstrapArtifact(release)).not.toBe(linked);
});

test("bounded artifact verification refuses partial results on limits, deadline and cancellation", async () => {
  const { release } = await fixture();
  const expected = await digestBootstrapArtifact(release);
  await expect(digestBootstrapArtifact(release, { maxFiles: 1 })).rejects.toThrow("limit exceeded");
  await expect(digestBootstrapArtifact(release, { maxBytes: 1 })).rejects.toThrow("limit exceeded");
  await expect(digestBootstrapArtifact(release, { timeoutMs: 0 })).rejects.toThrow("deadline");
  const controller = new AbortController();
  controller.abort();
  await expect(digestBootstrapArtifact(release, { signal: controller.signal })).rejects.toThrow(
    "cancelled",
  );
  expect(
    await digestBootstrapArtifact(release, { maxFiles: 10, maxBytes: 1000, timeoutMs: 10_000 }),
  ).toBe(expected);
});

test("retained artifact proof binds imported dependencies after successful collection", async () => {
  const { release } = await fixture();
  const inspected = await inspectBootstrapArtifact(release, {
    maxFiles: 32,
    maxBytes: 1024,
    timeoutMs: 1000,
  });
  expect(inspected.sha256).toBe(await digestBootstrapArtifact(release));
  expect(inspected.assertCurrent()).toBeUndefined();
  await writeFile(path.join(release, "entry.js"), "export const changed = true;", { mode: 0o600 });
  expect(() => inspected.assertCurrent()).toThrow("changed during verification");
});

test("retained artifact proof refuses a newly inserted runtime file", async () => {
  const { release } = await fixture();
  const inspected = await inspectBootstrapArtifact(release);
  await writeFile(path.join(release, "late.js"), "export {};", { mode: 0o600 });
  expect(() => inspected.assertCurrent()).toThrow("changed during verification");
});

test("successful artifact proof outlives its collection budget while preserving caller cancellation", async () => {
  const { release } = await fixture();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const cancellation = new AbortController();
    const inspected = await inspectBootstrapArtifact(release, {
      timeoutMs: 1000,
      signal: cancellation.signal,
    });
    clock.mockReturnValue(now + 2000);
    expect(inspected.assertCurrent()).toBeUndefined();
    cancellation.abort(new Error("Caller canceled"));
    expect(() => inspected.assertCurrent()).toThrow("Caller canceled");
  } finally {
    clock.mockRestore();
  }
});

test("retained artifact proof refuses substituting a directory alias", async () => {
  const { root, release } = await fixture();
  const inspected = await inspectBootstrapArtifact(release);
  const moved = path.join(root, "moved");
  await rename(release, moved);
  await symlink(moved, release);
  expect(() => inspected.assertCurrent()).toThrow("canonical directory");
});

test("retained artifact proof keeps the original caller cancellation signal", async () => {
  const { release } = await fixture();
  const original = new AbortController();
  const limits = { signal: original.signal };
  const inspected = await inspectBootstrapArtifact(release, limits);
  limits.signal = new AbortController().signal;
  original.abort(new Error("Original caller canceled"));
  expect(() => inspected.assertCurrent()).toThrow("Original caller canceled");
});

test("retained release proof binds the source receipt, external dependencies and runtime tree", async () => {
  for (const changed of ["configuration", "launcher", "node", "receipt", "dependency"] as const) {
    const { release, candidate } = await preparedReleaseFixture();
    const proof = await inspectBootstrapReleaseArtifacts(candidate, [], { timeoutMs: 1000 });
    expect(proof.assertCurrent()).toBeUndefined();
    const changedFile = {
      receipt: path.join(release, ".installation-source.json"),
      dependency: path.join(release, "new-import.js"),
      configuration: candidate.configuration.path,
      launcher: candidate.launcher.path,
      node: candidate.node.path,
    }[changed];
    await writeFile(changedFile, "changed bytes", { mode: 0o600 });
    expect(() => proof.assertCurrent()).toThrow("changed");
  }
});

test("retained release proof snapshots declarations and preserves original caller cancellation", async () => {
  const { candidate } = await preparedReleaseFixture();
  const cancellation = new AbortController();
  const limits = { signal: cancellation.signal, timeoutMs: 1000 };
  const proof = await inspectBootstrapReleaseArtifacts(candidate, [], limits);
  candidate.configuration.path = "/changed-after-collection";
  limits.signal = new AbortController().signal;
  expect(proof.assertCurrent()).toBeUndefined();
  cancellation.abort(new Error("Release caller canceled"));
  expect(() => proof.assertCurrent()).toThrow("Release caller canceled");
});

test("release collection refuses crossing its deadline during final synchronous custody", async () => {
  const { candidate } = await preparedReleaseFixture();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const { lstatSync: originalStat } = await vi.importActual<typeof import("node:fs")>("node:fs");
  const stat = vi.mocked(nativeFs.lstatSync).mockImplementation((...args) => {
    const result = Reflect.apply(originalStat, nativeFs, args);
    now += 1001;
    return result;
  });
  try {
    await expect(
      inspectBootstrapReleaseArtifacts(candidate, [], { timeoutMs: 1000 }),
    ).rejects.toThrow("deadline exceeded");
  } finally {
    stat.mockImplementation(originalStat);
    clock.mockRestore();
  }
});

test("copy source verification counts every internal hard link without loosening external dependencies", async () => {
  const { root, release } = await fixture();
  const first = path.join(release, "entry.js");
  const second = path.join(release, "alias.js");
  await link(first, second);
  const pin = { path: first, sha256: createHash("sha256").update("export {};").digest("hex") };
  await expect(
    verifyBootstrapPreparedCopySource(pin, release, [first, second], []),
  ).resolves.toBeUndefined();
  await expect(verifyBootstrapPreparedDependency(pin, [])).rejects.toThrow("bounded regular file");
  await expect(verifyBootstrapPreparedCopySource(pin, release, [first], [])).rejects.toThrow(
    "incomplete",
  );
  await expect(verifyBootstrapPreparedCopySource(pin, release, [first, first], [])).rejects.toThrow(
    "incomplete",
  );
  const outside = path.join(root, "outside.js");
  await link(first, outside);
  await expect(
    verifyBootstrapPreparedCopySource(pin, release, [first, second, outside], []),
  ).rejects.toThrow("escape");
});
