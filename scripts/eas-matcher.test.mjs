import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, Module } from "node:module";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const eas = createRequire(require.resolve("eas-cli/package.json"));

test("EAS provisioning identifiers retain exact and wildcard matching", async () => {
  const filename = eas.resolve("./build/credentials/ios/validators/validateProvisioningProfile.js");
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  // Exercise the existing private validator without certificates or Apple requests.
  module._compile(
    (await readFile(filename, "utf8")) + "\nexports.testIdentifier = validateBundleIdentifier;",
    filename,
  );
  const validate = module.exports.testIdentifier;
  const profile = (identifier) => ({ Entitlements: { "application-identifier": identifier } });
  assert.equal(validate(profile("TEAM.com.example.app"), "com.example.app"), true);
  assert.equal(validate(profile("TEAM.com.example.*"), "com.example.app"), true);
  assert.equal(validate(profile("TEAM.*"), "com.example.app"), true);
  assert.equal(validate(profile("TEAM.com.other.*"), "com.example.app"), false);
  assert.equal(validate(profile("TEAM.com.example.app"), "com.example.other"), false);
  assert.equal(validate(profile("TEAM"), "com.example.app"), false);
  assert.equal(validate({}, "com.example.app"), false);
});

test("EAS matcher bounds repeated globstar backtracking", async () => {
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const match = require(workerData);
     const pattern = Array(13).fill('**/a').join('/') + '/b';
     parentPort.postMessage(match(Array(30).fill('a').join('/'), pattern));`,
    {
      eval: true,
      workerData: eas.resolve("minimatch"),
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    },
  );
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Matcher exceeded the bounded worker deadline")),
        2000,
      );
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Matcher worker exited with ${code}`));
      });
    });
    assert.equal(result, false);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test("EAS brace expansion applies small explicit allocation limits", () => {
  const fromMatcher = createRequire(eas.resolve("minimatch"));
  const expand = fromMatcher("brace-expansion");
  assert.deepEqual(expand("{1..3}"), ["1", "2", "3"]);
  assert.deepEqual(expand("{1..10}", { max: 3 }), ["1", "2", "3"]);
  assert.deepEqual(expand("{a,b}{c,d}", { maxLength: 3 }), ["ac"]);
});
