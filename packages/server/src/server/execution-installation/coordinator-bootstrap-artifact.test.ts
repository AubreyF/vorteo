import {
  initialHostModuleEntries,
  initialHostModuleContractPath,
  inspectInitialHostModuleContract,
} from "./maintenance/host-startup-contract.js";
import { test, expect, afterEach, vi } from "vitest";
import * as nativeFs from "node:fs";
import {
  readdir,
  mkdtemp,
  cp,
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
  withBootstrapReleaseInspection,
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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
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

async function moduleContractFixture() {
  const f = await fixture();
  const referenceRoot = path.join(f.root, "reference");
  const candidateRoot = path.join(f.root, "candidate");
  const names = [
    ...initialHostModuleEntries,
    "packages/server/package.json",
    "packages/example/module.js",
  ];
  const files = [];
  for (const [index, name] of names.entries()) {
    const file = path.join(referenceRoot, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = "module-fixture-" + index;
    await writeFile(file, bytes, { mode: 0o600 });
    files.push({
      path: name,
      type: "file",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: false,
    });
  }
  const workspaceLink = "node_modules/example";
  await mkdir(path.dirname(path.join(referenceRoot, workspaceLink)), {
    recursive: true,
    mode: 0o700,
  });
  await symlink("../packages/example", path.join(referenceRoot, workspaceLink));
  const warnings: unknown[] = [];
  const manifest = {
    version: 1,
    purpose: "initial-host-module-contract",
    platform: "darwin",
    arch: process.arch,
    entries: [...initialHostModuleEntries],
    files: [...files, { path: workspaceLink, type: "link", target: "../packages/example" }],
    warnings,
    absent: [
      "packages/server/dist/server/node_modules",
      "node_modules/bufferutil",
      "packages/server/dist/package.json",
    ],
    directories: [],
  };
  const writeManifest = async (root = referenceRoot) => {
    const file = path.join(root, initialHostModuleContractPath);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
  };
  await writeManifest();
  await cp(referenceRoot, candidateRoot, { recursive: true, verbatimSymlinks: true });
  const controller = new AbortController();
  const input = { referenceRoot, candidateRoot, writableMountRoots: [], signal: controller.signal };
  return { ...f, input, manifest, writeManifest, controller };
}

test("initial Host module contract verifies code, metadata and internal workspace links", async () => {
  const f = await moduleContractFixture();
  const proof = await inspectInitialHostModuleContract(f.input);
  expect(() => proof.assertCurrent()).not.toThrow();
  f.controller.abort();
  expect(() => proof.assertCurrent()).toThrow();
});

test.each([
  "candidate code",
  "reference code",
  "package metadata",
  "workspace link",
  "contract document",
])("initial Host module contract retains %s after collection", async (changed) => {
  const f = await moduleContractFixture();
  const proof = await inspectInitialHostModuleContract(f.input);
  if (changed === "candidate code")
    await writeFile(path.join(f.input.candidateRoot, initialHostModuleEntries[0]), "changed");
  if (changed === "reference code")
    await writeFile(path.join(f.input.referenceRoot, initialHostModuleEntries[0]), "changed");
  if (changed === "package metadata")
    await writeFile(path.join(f.input.candidateRoot, "packages/server/package.json"), "changed");
  if (changed === "workspace link") {
    const file = path.join(f.input.candidateRoot, "node_modules/example");
    await rm(file);
    await symlink("../packages/server", file);
  }
  if (changed === "contract document") await f.writeManifest(f.input.candidateRoot);
  expect(() => proof.assertCurrent()).toThrow();
});

test.each(["duplicate", "escaping", "missing entry", "wrong architecture", "unknown warning"])(
  "initial Host module contract refuses repinned %s declarations",
  async (changed) => {
    const f = await moduleContractFixture();
    if (changed === "duplicate") f.manifest.files.push(f.manifest.files[0]);
    if (changed === "escaping") f.manifest.files[0].path = "../outside";
    if (changed === "missing entry") f.manifest.entries.reverse();
    if (changed === "wrong architecture") f.manifest.arch = "ia32";
    if (changed === "unknown warning")
      f.manifest.warnings.push({ module: "unreviewed", importer: "x.js", sha256: "a".repeat(64) });
    await f.writeManifest();
    await f.writeManifest(f.input.candidateRoot);
    await expect(inspectInitialHostModuleContract(f.input)).rejects.toThrow();
  },
);

test("initial Host module contract refuses a coherently repinned candidate dependency", async () => {
  const f = await moduleContractFixture();
  const bytes = "replacement metadata";
  const name = "packages/server/package.json";
  await writeFile(path.join(f.input.candidateRoot, name), bytes);
  const entry = f.manifest.files.find((file) => file.path === name)!;
  if (!("sha256" in entry)) throw new Error("Missing fixture module");
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  await f.writeManifest(f.input.candidateRoot);
  await expect(inspectInitialHostModuleContract(f.input)).rejects.toThrow(
    "module contract changed",
  );
});

test.each(["nearer package", "optional dependency", "package scope metadata"])(
  "initial Host module contract rejects %s appearing without listed-byte changes",
  async (changed) => {
    const f = await moduleContractFixture();
    let file;
    if (changed === "nearer package")
      file = "packages/server/dist/server/node_modules/example/index.js";
    else if (changed === "optional dependency") file = "node_modules/bufferutil/index.js";
    else file = "packages/server/dist/package.json";
    const target = path.join(f.input.candidateRoot, file);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, "unlisted shadow", { mode: 0o600 });
    // Coherently selecting a new artifact digest cannot make its changed lookup
    // behavior satisfy the unchanged executing-build module contract.
    expect(await digestBootstrapArtifact(f.input.candidateRoot)).toMatch(/^[a-f0-9]{64}$/);
    await expect(inspectInitialHostModuleContract(f.input)).rejects.toThrow(
      "lookup became present",
    );
  },
);

test("initial Host module contract retains absence through the final assertion", async () => {
  const f = await moduleContractFixture();
  const proof = await inspectInitialHostModuleContract(f.input);
  const folder = path.join(f.input.candidateRoot, "node_modules/bufferutil");
  await mkdir(folder, { mode: 0o700 });
  await writeFile(path.join(folder, "index.js"), "optional shadow", { mode: 0o600 });
  expect(() => proof.assertCurrent()).toThrow();
});

test.each(["missing lookup", "package metadata"])(
  "module trace rejects changed %s before generation",
  async (changed) => {
    const { createHostModuleTraceFilesystem } =
      await import("../../../scripts/build-host-startup-contract.mjs");
    const { root } = await fixture();
    const ports = createHostModuleTraceFilesystem(root);
    const file = path.join(root, "package.json");
    if (changed === "package metadata") {
      await writeFile(file, '{"type":"module"}', { mode: 0o600 });
      await ports.readFile(file);
    } else expect(await ports.stat(file)).toBeNull();
    await writeFile(file, '{"type":"commonjs"}', { mode: 0o600 });
    await expect(ports.finish()).rejects.toThrow("resolution changed");
  },
);

test("one verification reuses a runtime while validating separate configuration and launcher pins", async () => {
  const { root, release, candidate } = await preparedReleaseFixture();
  const configuration = path.join(root, "fallback.json");
  const launcher = path.join(root, "fallback.plist");
  await writeFile(configuration, "fallback config", { mode: 0o600 });
  await writeFile(launcher, "fallback launcher", { mode: 0o600 });
  const pin = (file: string, bytes: string) => ({
    path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const fallback = {
    ...candidate,
    configuration: pin(configuration, "fallback config"),
    launcher: pin(launcher, "fallback launcher"),
  };
  vi.mocked(readdir).mockClear();
  await withBootstrapReleaseInspection(async (inspect) => {
    await Promise.all([inspect(candidate, []), inspect(fallback, [])]);
    await inspect(candidate, []);
    await expect(
      inspect(
        {
          ...fallback,
          configuration: candidate.configuration,
          launcher: { ...fallback.launcher, sha256: "0".repeat(64) },
        },
        [],
      ),
    ).rejects.toThrow("digest changed");
    await expect(inspect(candidate, [root])).rejects.toThrow("mount");
  });
  expect(vi.mocked(readdir).mock.calls.filter(([directory]) => directory === release)).toHaveLength(
    1,
  );
  await withBootstrapReleaseInspection(async (inspect) => {
    await inspect(candidate, []);
  });
  expect(vi.mocked(readdir).mock.calls.filter(([directory]) => directory === release)).toHaveLength(
    2,
  );
});

test("reuse refuses a different expected digest and a canonical directory alias", async () => {
  const { root, release, candidate } = await preparedReleaseFixture();
  const alias = path.join(root, "alias");
  await symlink(release, alias);
  await withBootstrapReleaseInspection(async (inspect) => {
    await inspect(candidate, []);
    await expect(inspect({ ...candidate, artifactSha256: "0".repeat(64) }, [])).rejects.toThrow(
      "artifact changed",
    );
    await expect(inspect({ ...candidate, directory: alias }, [])).rejects.toThrow();
  });
});

test.each(["runtime", "configuration", "launcher", "node", "receipt"])(
  "verification refuses %s mutation after the final inspection callback",
  async (target) => {
    const { release, candidate } = await preparedReleaseFixture();
    const files: Record<string, string> = {
      runtime: path.join(release, "entry.js"),
      configuration: candidate.configuration.path,
      launcher: candidate.launcher.path,
      node: candidate.node.path,
      receipt: path.join(release, ".installation-source.json"),
    };
    await expect(
      withBootstrapReleaseInspection(async (inspect) => {
        await inspect(candidate, []);
        await inspect(candidate, []);
        await writeFile(files[target], "mutated after inspection");
      }),
    ).rejects.toThrow("changed");
  },
);

test("retained runtime mutation cannot be accepted by a later reuse", async () => {
  const { release, candidate } = await preparedReleaseFixture();
  await expect(
    withBootstrapReleaseInspection(async (inspect) => {
      await inspect(candidate, []);
      await writeFile(path.join(release, "extra.js"), "new dependency", { mode: 0o600 });
      await inspect(candidate, []);
    }),
  ).rejects.toThrow("changed");
});

test("inspection callable expires with its operation", async () => {
  const { candidate } = await preparedReleaseFixture();
  const retainedInspect = await withBootstrapReleaseInspection(async (inspect) => inspect);
  await expect(retainedInspect(candidate, [])).rejects.toThrow("scope ended");
});
