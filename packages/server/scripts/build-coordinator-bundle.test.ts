import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { runtimeNamedRunnerModules as contractModules } from "../src/server/execution-installation/coordinator-bootstrap-runner-modules.js";
import {
  buildCoordinatorBundle,
  coordinatorBundleEntries,
  runtimeNamedRunnerModules,
} from "./build-coordinator-bundle.mjs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const installation = "packages/server/dist/server/server/execution-installation";

interface ReleaseShape {
  artifactBody?: string;
  mainImports?: string;
}

/** A miniature release: two entrypoints, a verifier module, an npm dependency,
 * a workspace link, a runtime asset, owner scripts and unrelated app code. */
async function releaseFixture(shape: ReleaseShape = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "coordinator-bundle-")));
  roots.push(root);
  const write = async (name: string, text: string) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text, { mode: 0o644 });
  };
  await write("packages/server/package.json", JSON.stringify({ type: "module" }));
  await write(
    `${installation}/main.js`,
    shape.mainImports ??
      'import "dep"; import "@getpaseo/protocol"; import "./coordinator-bootstrap-artifact.js";',
  );
  await write(
    `${installation}/coordinator-bootstrap-runner.js`,
    'import "./coordinator-bootstrap-artifact.js";',
  );
  await write(
    `${installation}/coordinator-bootstrap-artifact.js`,
    shape.artifactBody ??
      `import { readFileSync } from "node:fs";
      import { value } from "dep";
      const asset = new URL("./assets.json", import.meta.url);
      export async function digestBootstrapArtifact() {
        readFileSync(asset);
        return value.repeat(64);
      }`,
  );
  await write(`${installation}/assets.json`, "{}");
  await write(
    "node_modules/dep/package.json",
    JSON.stringify({ name: "dep", type: "module", main: "index.js" }),
  );
  await write("node_modules/dep/index.js", 'export const value = "a";');
  await write(
    "packages/protocol/package.json",
    JSON.stringify({ name: "@getpaseo/protocol", type: "module", main: "index.js" }),
  );
  await write("packages/protocol/index.js", "export {};");
  await mkdir(path.join(root, "node_modules/@getpaseo"), { recursive: true });
  await symlink("../../packages/protocol", path.join(root, "node_modules/@getpaseo/protocol"));
  await write("scripts/run-coordinator-owner.py", "print('owner')");
  await write("scripts/verify-coordinator-owner.py", "print('verify')");
  await write("packages/app/huge.js", "export const unrelated = true;");
  await write(".installation-source.json", JSON.stringify({ sourceCommit: "a".repeat(40) }));
  // Runtime-named runner modules; recovery access has its own dependency.
  for (const entry of coordinatorBundleEntries)
    if (!existsSync(path.join(root, entry))) await write(entry, "export {};");
  await write(
    `${installation}/coordinator-bootstrap-maintenance-recovery-access.js`,
    'import "access-dep";',
  );
  await write(
    "node_modules/access-dep/package.json",
    JSON.stringify({ name: "access-dep", type: "module", main: "index.js" }),
  );
  await write("node_modules/access-dep/index.js", "export {};");
  await write("node_modules/unused/index.js", "export {};");
  return root;
}

test("the bundle holds exactly the coordinator closure, links and owner scripts", async () => {
  const root = await releaseFixture();
  const output = path.join(root, "coordinator");
  const bundle = await buildCoordinatorBundle(root);
  expect(bundle.output).toBe(output);
  expect(bundle.artifactSha256).toBe("a".repeat(64));
  const manifest = JSON.parse(readFileSync(path.join(output, "bundle.json"), "utf8"));
  const names = manifest.files.map((file: { path: string }) => file.path);
  expect(names).toEqual(
    expect.arrayContaining([
      `${installation}/main.js`,
      `${installation}/coordinator-bootstrap-runner.js`,
      `${installation}/coordinator-bootstrap-artifact.js`,
      `${installation}/assets.json`,
      "node_modules/dep/index.js",
      "node_modules/@getpaseo/protocol",
      "scripts/run-coordinator-owner.py",
      "scripts/verify-coordinator-owner.py",
    ]),
  );
  expect(names).not.toContain("packages/app/huge.js");
  expect(names).not.toContain("node_modules/unused/index.js");
  expect(existsSync(path.join(output, "packages/app"))).toBe(false);
  expect(await readlink(path.join(output, "node_modules/@getpaseo/protocol"))).toBe(
    "../../packages/protocol",
  );
  expect(readFileSync(path.join(output, `${installation}/main.js`), "utf8")).toBe(
    readFileSync(path.join(root, `${installation}/main.js`), "utf8"),
  );
});

test("an unclassified trace warning refuses the bundle", async () => {
  const root = await releaseFixture({ mainImports: 'import "missing-package";' });
  await expect(buildCoordinatorBundle(root)).rejects.toThrow("unclassified trace warning");
});

test("a verifier that reads outside the bundle fails the self-contained check", async () => {
  const root = await releaseFixture({
    artifactBody: `import { readFileSync } from "node:fs";
      import path from "node:path";
      export async function digestBootstrapArtifact(directory) {
        readFileSync(path.join(directory, "..", "packages/app/huge.js"));
        return "a".repeat(64);
      }`,
  });
  await expect(buildCoordinatorBundle(root)).rejects.toThrow("does not run self-contained");
});

test("an existing bundle output is never overwritten", async () => {
  const root = await releaseFixture();
  await mkdir(path.join(root, "coordinator"));
  await expect(buildCoordinatorBundle(root)).rejects.toThrow("already exists");
});

test("the build step is a no-op unless the bundle setting is enabled", async () => {
  const script = fileURLToPath(new URL("./build-coordinator-bundle.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    env: { PATH: "/usr/bin:/bin" },
  });
  expect(stdout).toBe("");
  expect(existsSync(fileURLToPath(new URL("../../../coordinator", import.meta.url)))).toBe(false);
});

test("every module the runner contract names at runtime ships with its own imports", async () => {
  expect([...runtimeNamedRunnerModules].sort()).toEqual([...contractModules].sort());
  const root = await releaseFixture();
  const bundle = await buildCoordinatorBundle(root);
  const manifest = JSON.parse(readFileSync(path.join(bundle.output, "bundle.json"), "utf8"));
  const names = new Set(manifest.files.map((file: { path: string }) => file.path));
  for (const module of contractModules)
    expect(names, module).toContain(path.posix.normalize(`${installation}/${module}`));
  expect(names).toContain("node_modules/access-dep/index.js");
  expect(names).toContain(".installation-source.json");
});

test("a release without its installation receipt is refused", async () => {
  const root = await releaseFixture();
  await rm(path.join(root, ".installation-source.json"));
  await expect(buildCoordinatorBundle(root)).rejects.toThrow(
    "Coordinator bundle input is missing: .installation-source.json",
  );
});
