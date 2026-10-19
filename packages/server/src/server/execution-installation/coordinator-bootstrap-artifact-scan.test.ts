import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import {
  inspectBootstrapArtifact,
  withBootstrapArtifactReuse,
} from "./coordinator-bootstrap-artifact.js";
import { workerExecArgv } from "./coordinator-bootstrap-artifact-scan.js";
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
afterEach(async () => {
  for (const root of roots.splice(0)) {
    execFileSync("chmod", ["-R", "u+rwx", root]);
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "artifact-scan-")));
  roots.push(root);
  return root;
}

function treeScans(directory: string): number {
  return vi
    .mocked(Worker)
    .mock.calls.filter(
      ([, options]) =>
        options?.workerData?.role === "vorteo-artifact-scan" &&
        options.workerData.directory === directory,
    ).length;
}

interface Outcome {
  sha256: string | null;
  error: string | null;
  code: string | null;
}

async function outcome(
  inspect: typeof inspectBootstrapArtifact,
  directory: string,
  limits: Parameters<typeof inspectBootstrapArtifact>[1] = {},
): Promise<Outcome> {
  try {
    return { sha256: (await inspect(directory, limits)).sha256, error: null, code: null };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : null;
    return { sha256: null, error: error instanceof Error ? error.message : String(error), code };
  }
}

async function expectEquivalent(
  directory: string,
  limits: Parameters<typeof inspectBootstrapArtifact>[1] = {},
): Promise<Outcome> {
  const legacy = await outcome(inspectLegacyBootstrapArtifact, directory, limits);
  const current = await outcome(inspectBootstrapArtifact, directory, limits);
  expect(current).toEqual(legacy);
  return current;
}

/** Covers chunk and batch boundaries, modes, sort order, links and hard links. */
async function richTree(): Promise<string> {
  const release = path.join(await scratch(), "release");
  await mkdir(release, { mode: 0o755 });
  await mkdir(path.join(release, "empty"), { mode: 0o700 });
  await mkdir(path.join(release, "nested", "deeper", "deepest"), { recursive: true, mode: 0o755 });
  const sizes = [0, 1, 65535, 65536, 65537, 1048575, 1048576, 1048577, 3 * 1048576 + 7];
  for (const [index, size] of sizes.entries())
    await writeFile(path.join(release, `size-${size}.bin`), Buffer.alloc(size, index + 1), {
      mode: 0o644,
    });
  // More files than one reader batch, so several readers share the work.
  for (let index = 0; index < 1200; index++)
    await writeFile(path.join(release, "nested", `module-${index}.js`), `export ${index};`, {
      mode: 0o600,
    });
  for (const name of ["B", "a", "a.b", "a-b", "10", "9", "é", "é", "日本"])
    await writeFile(path.join(release, "nested", "deeper", name), name, { mode: 0o640 });
  await writeFile(path.join(release, "tool"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(path.join(release, "readonly-tool"), "#!/bin/sh\n", { mode: 0o500 });
  await writeFile(path.join(release, "nested", "deeper", "deepest", "leaf"), "leaf", {
    mode: 0o400,
  });
  await symlink("tool", path.join(release, "relative-link"));
  await symlink(path.join(release, "nested"), path.join(release, "absolute-directory-link"));
  await symlink("relative-link", path.join(release, "link-to-link"));
  await symlink("..", path.join(release, "nested", "parent-link"));
  await link(path.join(release, "tool"), path.join(release, "nested", "tool-alias"));
  await link(path.join(release, "size-1.bin"), path.join(release, "hard-1"));
  await link(path.join(release, "size-1.bin"), path.join(release, "nested", "hard-2"));
  await chmod(path.join(release, "nested", "deeper", "deepest"), 0o500);
  return release;
}

test("off-thread digest is byte-identical to the sequential digest across tree shapes", async () => {
  const release = await richTree();
  const result = await expectEquivalent(release);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(treeScans(release)).toBe(1);
  const empty = path.join(await scratch(), "empty-release");
  await mkdir(empty, { mode: 0o700 });
  expect((await expectEquivalent(empty)).sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("file and byte limits refuse at the same boundaries as the sequential scan", async () => {
  const release = path.join(await scratch(), "release");
  await mkdir(path.join(release, "nested"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(release, "a"), "12345", { mode: 0o600 });
  await writeFile(path.join(release, "nested", "b"), "678", { mode: 0o600 });
  // Four entries (root, a, nested, nested/b) and eight bytes.
  for (const limits of [{ maxFiles: 4 }, { maxFiles: 3 }, { maxBytes: 8 }, { maxBytes: 7 }])
    await expectEquivalent(release, limits);
  expect((await outcome(inspectBootstrapArtifact, release, { maxFiles: 3 })).error).toBe(
    "Artifact verification limit exceeded",
  );
  expect((await outcome(inspectBootstrapArtifact, release, { maxBytes: 8 })).error).toBeNull();
});

test.each([
  ["escaping link", "Prepared artifact links outside its release"],
  ["dangling link", null],
  ["named pipe", "Prepared artifact contains a non-runtime file type"],
  ["socket", "Prepared artifact contains a non-runtime file type"],
  ["group-writable file", "Prepared artifact is writable by another account"],
  ["world-writable directory", "Prepared artifact is writable by another account"],
  ["external hard link", "Prepared hard-linked file escapes its release"],
  ["directory alias", "Prepared artifact requires a canonical directory"],
  ["regular file root", "Prepared artifact must be a directory"],
  ["missing root", null],
  ["unreadable file", null],
] as const)("refuses a %s exactly as the sequential scan does", async (shape, message) => {
  const root = await scratch();
  const release = path.join(root, "release");
  await mkdir(release, { mode: 0o700 });
  await writeFile(path.join(release, "entry.js"), "export {};", { mode: 0o600 });
  let target = release;
  const servers: Array<ReturnType<typeof createServer>> = [];
  if (shape === "escaping link") await symlink(root, path.join(release, "escape"));
  if (shape === "dangling link") await symlink("missing", path.join(release, "dangling"));
  if (shape === "named pipe") execFileSync("mkfifo", [path.join(release, "pipe")]);
  if (shape === "socket") {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path.join(release, "s"), resolve));
  }
  if (shape === "group-writable file") {
    await writeFile(path.join(release, "shared.js"), "x");
    await chmod(path.join(release, "shared.js"), 0o620);
  }
  if (shape === "world-writable directory") {
    await mkdir(path.join(release, "shared"));
    await chmod(path.join(release, "shared"), 0o757);
  }
  if (shape === "external hard link")
    await link(path.join(release, "entry.js"), path.join(root, "outside.js"));
  if (shape === "directory alias") {
    target = path.join(root, "alias");
    await symlink(release, target);
  }
  if (shape === "regular file root") target = path.join(release, "entry.js");
  if (shape === "missing root") target = path.join(root, "missing");
  if (shape === "unreadable file") await chmod(path.join(release, "entry.js"), 0o000);
  try {
    const result = await expectEquivalent(target);
    expect(result.sha256).toBeNull();
    if (message) expect(result.error).toBe(message);
    else expect(result.code).toMatch(/^E[A-Z]+$/);
  } finally {
    for (const server of servers) server.close();
  }
});

test("retained proofs refuse the same post-collection changes as the sequential proof", async () => {
  const changes: Record<string, (release: string) => Promise<void>> = {
    content: (release) => writeFile(path.join(release, "nested", "module-7.js"), "changed"),
    mode: (release) => chmod(path.join(release, "tool"), 0o700),
    inserted: (release) => writeFile(path.join(release, "nested", "deeper", "new"), "x"),
    "restored mtime": async (release) => {
      const file = path.join(release, "size-0.bin");
      await writeFile(file, "x");
      await utimes(file, new Date(0), new Date(0));
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    const release = await richTree();
    const legacy = await inspectLegacyBootstrapArtifact(release);
    const current = await inspectBootstrapArtifact(release);
    expect(current.assertCurrent()).toBeUndefined();
    await change(release);
    expect(() => legacy.assertCurrent(), name).toThrow("changed during verification");
    expect(() => current.assertCurrent(), name).toThrow("changed during verification");
  }
});

test("cancellation and deadlines stop an in-flight scan", async () => {
  const release = await richTree();
  const cancellation = new AbortController();
  const cancelled = inspectBootstrapArtifact(release, { signal: cancellation.signal });
  cancellation.abort();
  await expect(cancelled).rejects.toThrow("Artifact verification cancelled");
  await expect(inspectBootstrapArtifact(release, { timeoutMs: 1 })).rejects.toThrow(
    "Artifact verification deadline exceeded",
  );
});

test("one caller's cancellation neither rejects nor poisons another caller's shared scan", async () => {
  const release = await richTree();
  const expected = (await inspectLegacyBootstrapArtifact(release)).sha256;
  vi.mocked(Worker).mockClear();
  await withBootstrapArtifactReuse(async () => {
    const impatient = new AbortController();
    const first = inspectBootstrapArtifact(release, { signal: impatient.signal });
    const second = inspectBootstrapArtifact(release);
    impatient.abort();
    await expect(first).rejects.toThrow("Artifact verification cancelled");
    expect((await second).sha256).toBe(expected);
    expect((await inspectBootstrapArtifact(release, { timeoutMs: 60_000 })).sha256).toBe(expected);
  });
  expect(treeScans(release)).toBe(1);
});

test("an abandoned shared scan is not reused by a later caller in the operation", async () => {
  const release = await richTree();
  const expected = (await inspectLegacyBootstrapArtifact(release)).sha256;
  vi.mocked(Worker).mockClear();
  await withBootstrapArtifactReuse(async () => {
    const impatient = new AbortController();
    const first = inspectBootstrapArtifact(release, { signal: impatient.signal });
    impatient.abort();
    await expect(first).rejects.toThrow("Artifact verification cancelled");
    const abandoned = new AbortController();
    const second = inspectBootstrapArtifact(release, { signal: abandoned.signal });
    abandoned.abort();
    await expect(second).rejects.toThrow("Artifact verification cancelled");
    expect((await inspectBootstrapArtifact(release)).sha256).toBe(expected);
  });
  expect(treeScans(release)).toBe(3);
});

test("limits are part of reuse identity and a rejected scan is collected again", async () => {
  const release = await richTree();
  const expected = (await inspectLegacyBootstrapArtifact(release)).sha256;
  vi.mocked(Worker).mockClear();
  await withBootstrapArtifactReuse(async () => {
    await expect(inspectBootstrapArtifact(release, { maxFiles: 10 })).rejects.toThrow(
      "limit exceeded",
    );
    expect((await inspectBootstrapArtifact(release)).sha256).toBe(expected);
    await expect(inspectBootstrapArtifact(release, { maxFiles: 10 })).rejects.toThrow(
      "limit exceeded",
    );
  });
  expect(treeScans(release)).toBe(3);
});

test("a reused proof is re-asserted before it satisfies a later caller", async () => {
  const release = await richTree();
  await expect(
    withBootstrapArtifactReuse(async () => {
      await inspectBootstrapArtifact(release);
      await writeFile(path.join(release, "late.js"), "x", { mode: 0o600 });
      await inspectBootstrapArtifact(release);
    }),
  ).rejects.toThrow("changed during verification");
});

test("workers drop main-input options in inline and separate forms", () => {
  expect(
    workerExecArgv([
      "--input-type=module",
      "--eval",
      "await main()",
      "--max-old-space-size=4096",
      "--input-type",
      "commonjs",
      "-e",
      "x",
      "--print",
      "y",
      "-p",
      "z",
      "--experimental-default-type=module",
      "--conditions",
      "development",
      "--permission",
    ]),
  ).toEqual(["--max-old-space-size=4096", "--conditions", "development", "--permission"]);
});

const scanModule = new URL("./coordinator-bootstrap-artifact-scan.ts", import.meta.url).href;

/** Mirrors the bounded verification children (retained renewal and plan
 * verification): module input through --eval, stdin payload, reduced
 * environment and a stdout handshake bound to the payload digest. */
function digestInChild(directory: string, inputType: readonly string[]) {
  const payload = JSON.stringify({ directory });
  const source = `
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scanArtifactTree } from ${JSON.stringify(scanModule)};
const bytes = readFileSync(0);
const input = JSON.parse(bytes.toString("utf8"));
const scan = await scanArtifactTree(input.directory, { maxFiles: Infinity, maxBytes: Infinity, deadline: Infinity });
process.stdout.write("verified:" + createHash("sha256").update(bytes).digest("hex") + "\\n" + scan.sha256);
`;
  const child = spawnSync(process.execPath, [...inputType, "--eval", source], {
    input: payload,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
    encoding: "utf8",
    timeout: 120_000,
  });
  const [handshake, digest] = child.stdout.split("\n");
  return {
    status: child.status,
    stderr: child.stderr,
    handshake,
    expectedHandshake: `verified:${createHash("sha256").update(payload).digest("hex")}`,
    digest,
  };
}

test.each([
  ["inline", ["--input-type=module"]],
  ["separate", ["--input-type", "module"]],
])(
  "a full digest with parallel readers runs inside a %s --input-type=module --eval child",
  async (_form, inputType) => {
    const release = await richTree();
    const expected = (await inspectLegacyBootstrapArtifact(release)).sha256;
    const result = digestInChild(release, inputType);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.handshake).toBe(result.expectedHandshake);
    expect(result.digest).toBe(expected);
  },
);
