import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const require = createRequire(import.meta.url);
const concurrent = createRequire(require.resolve("concurrently"));
const shellQuote = concurrent("shell-quote");
const {
  ExpandArguments,
} = require("../node_modules/concurrently/dist/src/command-parser/expand-arguments.js");
const execute = promisify(execFile);

test("Concurrently argument expansion preserves shell metacharacters as literal arguments", async () => {
  const values = [
    "two words",
    "semi; printf INJECTED",
    "$(printf INJECTED)",
    "line\nbreak",
    "quote'and\"double",
  ];
  const prefix = shellQuote.quote([
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "--",
  ]);
  const { command } = new ExpandArguments(values).parse({ command: `${prefix} {@}` });
  const { stdout, stderr } = await execute("/bin/sh", ["-c", command], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), values);
  assert.equal(stderr, "");
});

test("shell-quote rejects an operator token containing a newline", () => {
  assert.throws(() => shellQuote.quote([{ op: "\nprintf INJECTED" }]), TypeError);
});

for (const consumer of [
  "@expo/cli",
  "@mapbox/node-pre-gyp",
  "app-builder-lib",
  "node-gyp",
  "eas-cli",
]) {
  test(`${consumer} tar round-trips archives without following extraction-directory symlinks`, async () => {
    const owner = createRequire(
      new URL(`../node_modules/${consumer}/package.json`, import.meta.url),
    );
    const tar = owner("tar");
    const root = await mkdtemp(path.join(tmpdir(), "tooling-tar-"));
    try {
      const source = path.join(root, "source"),
        output = path.join(root, "output"),
        outside = path.join(root, "outside");
      await mkdir(path.join(source, "inner"), { recursive: true });
      await mkdir(output);
      await mkdir(outside);
      await writeFile(path.join(source, "inner", "résumé.txt"), "archive fixture");
      const archive = path.join(root, "fixture.tgz");
      await tar.c({ cwd: source, file: archive, gzip: true }, ["inner/résumé.txt"]);
      await tar.x({ cwd: output, file: archive, strict: true });
      assert.equal(
        await readFile(path.join(output, "inner", "résumé.txt"), "utf8"),
        "archive fixture",
      );
      await rm(path.join(output, "inner"), { recursive: true });
      await writeFile(path.join(outside, "résumé.txt"), "outside canary");
      await symlink(outside, path.join(output, "inner"));
      await assert.rejects(tar.x({ cwd: output, file: archive, strict: true }));
      assert.equal(await readFile(path.join(outside, "résumé.txt"), "utf8"), "outside canary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
