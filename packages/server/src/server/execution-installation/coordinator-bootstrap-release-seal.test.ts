import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  inspectBootstrapArtifact,
  sealBootstrapRelease,
} from "./coordinator-bootstrap-artifact.js";
import {
  releaseAdmissionReceipt,
  releaseSealFiles,
  removeBootstrapRelease,
  unsealBootstrapRelease,
} from "./coordinator-bootstrap-release-seal.js";
import { inspectLegacyBootstrapArtifact } from "./test-utils/legacy-artifact-digest.js";

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: vi.fn(function (...args: ConstructorParameters<typeof actual.Worker>) {
      return new actual.Worker(...args);
    }),
  };
});

const roots: string[] = [];
beforeEach(() => {
  process.env.VORTEO_RELEASE_SEALS = "enabled";
});
afterEach(async () => {
  delete process.env.VORTEO_RELEASE_SEALS;
  for (const root of roots.splice(0)) {
    execFileSync("/usr/bin/chflags", ["-R", "nouchg", root]);
    await rm(root, { recursive: true, force: true });
  }
});

function byteScans(directory: string): number {
  return vi
    .mocked(Worker)
    .mock.calls.filter(
      ([, options]) =>
        options?.workerData?.role === "vorteo-artifact-scan" &&
        options.workerData.directory === directory,
    ).length;
}

function clearFlag(file: string): void {
  execFileSync("/usr/bin/chflags", ["nouchg", file]);
}

async function releaseFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "release-seal-")));
  roots.push(root);
  const release = path.join(root, "release");
  await mkdir(path.join(release, "node_modules", "pkg", "dist"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(release, "packages", "app"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(release, "entry.js"), "export {};", { mode: 0o644 });
  await writeFile(path.join(release, "tool"), "#!/bin/sh\n", { mode: 0o755 });
  await symlink("tool", path.join(release, "tool-link"));
  await link(path.join(release, "tool"), path.join(release, "packages", "tool-alias"));
  // Published packages legitimately ship cache-like names inside their own trees.
  await writeFile(path.join(release, "node_modules", "pkg", ".eslintcache"), "{}", { mode: 0o644 });
  await writeFile(path.join(release, "node_modules", "pkg", "dist", "a.tsbuildinfo"), "{}", {
    mode: 0o644,
  });
  await mkdir(path.join(release, "node_modules", "pkg", "dist", ".vite"), { mode: 0o755 });
  await symlink("../../node_modules/pkg", path.join(release, "packages", "app", "pkg"));
  return release;
}

/** Seals the way preparation does, including the admission receipt binding. */
async function sealRelease(release: string): Promise<string> {
  const sealed = await sealBootstrapRelease(release, { timeoutMs: 60_000 });
  await writeFile(
    releaseAdmissionReceipt(release),
    JSON.stringify({ candidateArtifactSha256: sealed.artifactSha256, candidateSeal: sealed.seal }),
    { mode: 0o600 },
  );
  return sealed.artifactSha256;
}

// Seals use macOS immutable file flags; other platforms refuse sealing outright.
describe.runIf(process.platform === "darwin")("release seals on macOS", () => {
  test("sealing keeps the v1 digest and records a manifest that hashes to it", async () => {
    const release = await releaseFixture();
    const expected = (await inspectLegacyBootstrapArtifact(release)).sha256;
    expect(await sealRelease(release)).toBe(expected);
    const manifest = readFileSync(releaseSealFiles(release).manifest);
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(expected);
    expect(manifest.toString("utf8").startsWith("vorteo-coordinator-artifact-v1\n")).toBe(true);
  });

  test("a sealed release refuses writes, new entries and mode changes", async () => {
    const release = await releaseFixture();
    await sealRelease(release);
    await expect(writeFile(path.join(release, "entry.js"), "changed")).rejects.toThrow("EPERM");
    await expect(mkdir(path.join(release, "node_modules", ".vite"))).rejects.toThrow("EPERM");
    expect(() =>
      execFileSync("chmod", ["600", path.join(release, "tool")], { stdio: "ignore" }),
    ).toThrow();
    await expect(writeFile(releaseSealFiles(release).header, "{}")).rejects.toThrow("EPERM");
  });

  test("an unchanged sealed release is accepted by metadata sweep without reading bytes", async () => {
    const release = await releaseFixture();
    const digest = await sealRelease(release);
    vi.mocked(Worker).mockClear();
    const proof = await inspectBootstrapArtifact(release, { timeoutMs: 60_000 });
    expect(proof.sha256).toBe(digest);
    expect(proof.assertCurrent()).toBeUndefined();
    expect(byteScans(release)).toBe(0);
  });

  test("with the setting off a sealed release is verified by bytes", async () => {
    const release = await releaseFixture();
    const digest = await sealRelease(release);
    delete process.env.VORTEO_RELEASE_SEALS;
    vi.mocked(Worker).mockClear();
    expect((await inspectBootstrapArtifact(release)).sha256).toBe(digest);
    expect(byteScans(release)).toBe(1);
  });

  test("changed bytes in a sealed release are refused with the changed path named", async () => {
    const release = await releaseFixture();
    await sealRelease(release);
    clearFlag(path.join(release, "entry.js"));
    await writeFile(path.join(release, "entry.js"), "export const changed = true;");
    await expect(inspectBootstrapArtifact(release)).rejects.toThrow(
      "Installed release was modified after it was sealed: entry.js (changed)",
    );
  });

  test("a tool cache written into a sealed release is refused and named", async () => {
    const release = await releaseFixture();
    await sealRelease(release);
    const modules = path.join(release, "node_modules");
    clearFlag(modules);
    await mkdir(path.join(modules, ".vite", "vitest"), { recursive: true });
    await writeFile(path.join(modules, ".vite", "vitest", "results.json"), "{}");
    await expect(inspectBootstrapArtifact(release)).rejects.toThrow(
      "modified after it was sealed: node_modules/.vite (added)",
    );
  });

  test("a metadata-only change falls back to bytes and accepts identical content", async () => {
    const release = await releaseFixture();
    const digest = await sealRelease(release);
    const file = path.join(release, "entry.js");
    clearFlag(file);
    execFileSync("/usr/bin/chflags", ["uchg", file]);
    vi.mocked(Worker).mockClear();
    expect((await inspectBootstrapArtifact(release)).sha256).toBe(digest);
    expect(byteScans(release)).toBe(1);
  });

  test("an unusable seal record falls back to byte verification", async () => {
    const release = await releaseFixture();
    const digest = await sealRelease(release);
    const { observed } = releaseSealFiles(release);
    clearFlag(observed);
    await writeFile(observed, "forged");
    vi.mocked(Worker).mockClear();
    expect((await inspectBootstrapArtifact(release)).sha256).toBe(digest);
    expect(byteScans(release)).toBe(1);
  });

  test.each([
    ["vite cache", "node_modules/.vite/deps/chunk.js"],
    ["generic cache", "packages/app/node_modules/.cache/babel.json"],
    ["root lint cache", ".eslintcache"],
    ["vitest cache", "node_modules/.vitest/results.json"],
  ])("install-time policy refuses a %s and leaves the tree unsealed", async (_name, cache) => {
    const release = await releaseFixture();
    await mkdir(path.dirname(path.join(release, cache)), { recursive: true, mode: 0o755 });
    await writeFile(path.join(release, cache), "{}", { mode: 0o644 });
    await expect(sealBootstrapRelease(release)).rejects.toThrow(
      "Release contains development tool output or linked dependencies",
    );
    expect(Object.values(releaseSealFiles(release)).filter((file) => existsSync(file))).toEqual([]);
    await expect(
      writeFile(path.join(release, "entry.js"), "still writable"),
    ).resolves.toBeUndefined();
  });

  test("install-time policy refuses linked node_modules trees", async () => {
    for (const [linkPath, target] of [
      ["packages/app/node_modules", "../../node_modules"],
      ["packages/app/deps", "../../node_modules"],
    ]) {
      const release = await releaseFixture();
      await symlink(target, path.join(release, linkPath));
      await expect(sealBootstrapRelease(release)).rejects.toThrow(linkPath);
    }
  });

  test("resealing is refused without disturbing the existing seal", async () => {
    const release = await releaseFixture();
    const digest = await sealRelease(release);
    await expect(sealBootstrapRelease(release)).rejects.toThrow("already sealed");
    vi.mocked(Worker).mockClear();
    expect((await inspectBootstrapArtifact(release)).sha256).toBe(digest);
    expect(byteScans(release)).toBe(0);
  });

  test("unsealing restores writability and removes every seal record", async () => {
    const release = await releaseFixture();
    await sealRelease(release);
    await unsealBootstrapRelease(release);
    expect(Object.values(releaseSealFiles(release)).filter((file) => existsSync(file))).toEqual([]);
    await expect(writeFile(path.join(release, "entry.js"), "writable")).resolves.toBeUndefined();
  });

  test("a seal rewritten to fit a changed tree is not honoured without its admission binding", async () => {
    const release = await releaseFixture();
    const original = await sealRelease(release);
    const files = releaseSealFiles(release);
    const originalManifest = readFileSync(files.manifest);
    // A same-account writer clears the flags, edits bytes and re-seals the tree,
    // then forges the header and manifest back to the approved digest.
    await unsealBootstrapRelease(release);
    await writeFile(path.join(release, "entry.js"), "export const forged = true;");
    const resealed = await sealBootstrapRelease(release);
    execFileSync("/usr/bin/chflags", ["nouchg", files.header, files.manifest]);
    const header = JSON.parse(readFileSync(files.header, "utf8"));
    await writeFile(
      files.header,
      JSON.stringify({ ...header, artifactSha256: original, manifestSha256: original }),
    );
    await writeFile(files.manifest, originalManifest);
    vi.mocked(Worker).mockClear();
    const verified = await inspectBootstrapArtifact(release);
    expect(verified.sha256).toBe(resealed.artifactSha256);
    expect(verified.sha256).not.toBe(original);
    expect(byteScans(release)).toBe(1);
  });

  test("a manifest that does not hash to the sealed digest falls back to bytes", async () => {
    const release = await releaseFixture();
    const digest = await sealRelease(release);
    const { manifest } = releaseSealFiles(release);
    clearFlag(manifest);
    await writeFile(manifest, "vorteo-coordinator-artifact-v1\n");
    vi.mocked(Worker).mockClear();
    expect((await inspectBootstrapArtifact(release)).sha256).toBe(digest);
    expect(byteScans(release)).toBe(1);
  });

  test("sealing refuses while a release file is open for writing", async () => {
    const release = await releaseFixture();
    const writer = await open(path.join(release, "entry.js"), "a");
    try {
      await expect(sealBootstrapRelease(release)).rejects.toThrow(
        `open for writing by process ${process.pid}`,
      );
    } finally {
      await writer.close();
    }
    expect(Object.values(releaseSealFiles(release)).filter((file) => existsSync(file))).toEqual([]);
    await expect(writeFile(path.join(release, "entry.js"), "writable")).resolves.toBeUndefined();
  });

  test("removing a sealed release clears its flags and deletes it with its records", async () => {
    const release = await releaseFixture();
    await sealRelease(release);
    await removeBootstrapRelease(release);
    expect(existsSync(release)).toBe(false);
    expect(Object.values(releaseSealFiles(release)).filter((file) => existsSync(file))).toEqual([]);
  });
});

test("sealing refuses off macOS before touching the tree", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    await expect(sealBootstrapRelease("/nonexistent-release")).rejects.toThrow(
      "Release seals require macOS",
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
