import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, mkdir, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import { createRequire, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeModule = "packages/server/dist/server/server/agent/providers/opencode/bridge.js";

// Mirrors nix/package.nix's installPhase: copy every traced path into $out.
async function installTracedDaemon(outRoot, sourceRoot = repoRoot) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(sourceRoot, "scripts/trace-daemon.mjs")],
    { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const file of stdout.split("\n").filter(Boolean)) {
    await cp(path.join(sourceRoot, file), path.join(outRoot, file), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

test("traced daemon closure ships the OpenCode bridge plugin for every OpenCode version", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-dist-"));
  try {
    await installTracedDaemon(outRoot);
    const installedBridgeUrl = pathToFileURL(path.join(outRoot, bridgeModule)).href;
    const { loadOpenCodeBridgePluginArtifact } = await import(installedBridgeUrl);

    for (const version of [1, 2]) {
      const artifact = await loadOpenCodeBridgePluginArtifact(
        installedBridgeUrl,
        undefined,
        version,
      );
      assert.ok(artifact.byteLength > 0, `OpenCode v${version} bridge plugin is empty`);
    }
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

for (const layout of ["workspace", "hoisted"]) {
  for (const nativeKind of ["prebuild", "release"]) {
    test(`node-pty native inputs load from ${layout} dependencies with ${nativeKind} binaries`, async (t) => {
      const fixture = await mkdtemp(path.join(os.tmpdir(), "trace-node-pty-"));
      t.after(() => rm(fixture, { recursive: true, force: true }));
      const serverRoot = path.join(fixture, "packages/server");
      const dependencyRoot = layout === "workspace" ? serverRoot : fixture;
      const packageRoot = path.join(dependencyRoot, "node_modules/node-pty");
      const serverRequire = createRequire(path.join(repoRoot, "packages/server/package.json"));
      const installedPackage = path.dirname(serverRequire.resolve("node-pty/package.json"));
      const platformDir = `prebuilds/${process.platform}-${process.arch}`;
      const nativeDir = nativeKind === "prebuild" ? platformDir : "build/Release";
      await mkdir(packageRoot, { recursive: true });
      await cp(path.join(installedPackage, "lib"), path.join(packageRoot, "lib"), {
        recursive: true,
      });
      await cp(path.join(installedPackage, "package.json"), path.join(packageRoot, "package.json"));
      // Exercise the real loader with the same platform addon in either supported location.
      await cp(path.join(installedPackage, platformDir), path.join(packageRoot, nativeDir), {
        recursive: true,
      });
      const files = {
        "packages/server/package.json": JSON.stringify({ name: "fixture-server", type: "module" }),
        "packages/cli/dist/index.js": "",
        "packages/server/dist/scripts/supervisor-entrypoint.js": 'import "node-pty";',
        "packages/server/dist/server/terminal/terminal-worker-process.js": "",
        "packages/server/dist/server/server/speech/providers/local/worker-process.js": "",
        "packages/server/dist/server/server/execution-installation/maintenance/host-startup-contract.json":
          "{}",
        "packages/server/dist/server/server/speech/providers/local/sherpa/assets/silero_vad.onnx":
          "fixture",
        "packages/server/.env.example": "",
        "packages/cli/bin/paseo": "",
      };
      for (const [file, bytes] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
        await writeFile(path.join(fixture, file), bytes);
      }
      // Use the real runtime helper without requiring an unrelated full server build.
      const sherpaSource =
        "packages/server/src/server/speech/providers/local/sherpa/sherpa-runtime-env.ts";
      const sherpaOutput =
        "packages/server/dist/server/server/speech/providers/local/sherpa/sherpa-runtime-env.js";
      await writeFile(
        path.join(fixture, sherpaOutput),
        stripTypeScriptTypes(await readFile(path.join(repoRoot, sherpaSource), "utf8")),
      );
      await mkdir(path.join(fixture, "scripts"));
      await cp(
        path.join(repoRoot, "scripts/trace-daemon.mjs"),
        path.join(fixture, "scripts/trace-daemon.mjs"),
      );
      await mkdir(path.join(fixture, "node_modules/@vercel"), { recursive: true });
      await symlink(
        path.join(repoRoot, "node_modules/@vercel/nft"),
        path.join(fixture, "node_modules/@vercel/nft"),
        "junction",
      );
      const output = path.join(fixture, "output");
      await installTracedDaemon(output, fixture);
      // A separate process releases native DLL mappings before cleanup on Windows.
      await promisify(execFile)(process.execPath, [
        "-e",
        'const assert = require("node:assert/strict"); const { createRequire } = require("node:module"); const server = createRequire(process.argv[1]); assert.equal(typeof server("node-pty").spawn, "function");',
        path.join(output, "packages/server/package.json"),
      ]);
      const nativeRelative = path.relative(fixture, path.join(packageRoot, nativeDir));
      // Companion assets, including macOS spawn-helper and Windows executables, must survive too.
      const originalNative = path.join(packageRoot, nativeDir);
      const copiedNative = path.join(output, nativeRelative);
      const originalEntries = await readdir(originalNative, {
        recursive: true,
        withFileTypes: true,
      });
      const originalFiles = originalEntries.filter((entry) => entry.isFile());
      assert.deepEqual(
        (await readdir(copiedNative, { recursive: true })).sort(),
        (await readdir(originalNative, { recursive: true })).sort(),
      );
      for (const asset of originalFiles) {
        const originalFile = path.join(asset.parentPath, asset.name);
        const relativeFile = path.relative(originalNative, originalFile);
        assert.deepEqual(
          await readFile(path.join(copiedNative, relativeFile)),
          await readFile(originalFile),
        );
      }
    });
  }
}
