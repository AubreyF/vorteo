import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, Module } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const eas = createRequire(require.resolve("eas-cli/package.json"));
const tar = eas("tar");

test("EAS creates an upload archive and extracts through its JS fallback without network access", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eas-archive-"));
  const paths = eas("./build/utils/paths.js");
  const originalTmp = paths.getTmpDirectory;
  paths.getTmpDirectory = () => directory;
  const uploadPath = eas.resolve("./build/uploads.js");
  const spawnPath = eas.resolve("@expo/spawn-async");
  const savedUpload = require.cache[uploadPath];
  const savedSpawn = require.cache[spawnPath];
  let captured;
  require.cache[uploadPath] = {
    id: uploadPath,
    filename: uploadPath,
    loaded: true,
    exports: {
      uploadFileAtPathToGCSAsync: async (_client, _kind, filename) => {
        captured = filename;
        return "synthetic-key";
      },
    },
  };
  require.cache[spawnPath] = {
    id: spawnPath,
    filename: spawnPath,
    loaded: true,
    exports: async () => {
      throw new Error("Synthetic native-tar failure");
    },
  };
  try {
    const app = path.join(directory, "Example.app");
    await mkdir(app);
    await writeFile(path.join(app, "fixture.txt"), "archive fixture");
    const filename = eas.resolve("./build/commands/upload.js");
    const module = new Module(filename);
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    // Expose the existing private helper only in this disposable test module.
    module._compile(
      (await readFile(filename, "utf8")) + "\nexports.testUpload = uploadAppArchiveAsync;",
      filename,
    );
    assert.equal(await module.exports.testUpload({}, app), "synthetic-key");
    const entries = [];
    await tar.list({ file: captured, onentry: (entry) => entries.push(entry.path) });
    assert.ok(entries.includes("Example.app/fixture.txt"));
    const { extractAppFromLocalArchiveAsync } = eas("./build/utils/download.js");
    const result = await extractAppFromLocalArchiveAsync(captured, "IOS");
    assert.equal(await readFile(path.join(result, "fixture.txt"), "utf8"), "archive fixture");
    assert.ok(result.startsWith(directory + path.sep));
  } finally {
    paths.getTmpDirectory = originalTmp;
    if (savedUpload) require.cache[uploadPath] = savedUpload;
    else delete require.cache[uploadPath];
    if (savedSpawn) require.cache[spawnPath] = savedSpawn;
    else delete require.cache[spawnPath];
    await rm(directory, { recursive: true, force: true });
  }
});
