import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

for (const consumer of ["micromatch", "@expo/cli", "fast-glob"]) {
  test(`${consumer} matching does not treat inherited properties as POSIX classes`, () => {
    const fromConsumer = createRequire(require.resolve(`${consumer}/package.json`));
    const picomatch = fromConsumer("picomatch");
    assert.equal(picomatch("[[:alpha:]].ts")("a.ts"), true);
    assert.equal(picomatch("[[:alpha:]].ts")("1.ts"), false);
    const inherited = picomatch.makeRe("[[:constructor:]]");
    assert.equal(inherited.source.includes("native code"), false);
    assert.equal(inherited.test("c"), false);
    assert.equal(picomatch("src/**/*.{ts,tsx}")("src/nested/view.tsx"), true);
  });
}

for (const consumer of ["@babel/cli", "@expo/cli/node_modules/glob"]) {
  test(`${consumer} brace expansion preserves patterns and respects explicit work limits`, () => {
    const fromConsumer = createRequire(require.resolve(`${consumer}/package.json`));
    const module = fromConsumer("brace-expansion");
    const expand = typeof module === "function" ? module : module.expand;
    assert.deepEqual(expand("file{1..3}.{ts,tsx}"), [
      "file1.ts",
      "file1.tsx",
      "file2.ts",
      "file2.tsx",
      "file3.ts",
      "file3.tsx",
    ]);
    // Small limits prove enforcement without allocating an attack-sized expansion.
    assert.deepEqual(expand("{1..10}", { max: 3 }), ["1", "2", "3"]);
    assert.deepEqual(expand("{a,b}{c,d}", { maxLength: 3 }), ["ac"]);
    assert.deepEqual(expand("{{{{a,b}}}}", { maxDepth: 2 }), ["{{{{a,b}}}}"]);
  });
}

test("file discovery preserves extension, exclusion and hidden-file behavior", async () => {
  const glob = require("fast-glob");
  const directory = await mkdtemp(path.join(tmpdir(), "glob-boundary-"));
  try {
    await mkdir(path.join(directory, "src"));
    for (const name of ["view.tsx", "model.ts", "model.test.ts", ".hidden.ts", "notes.md"]) {
      await writeFile(path.join(directory, "src", name), "fixture");
    }
    const options = { cwd: directory, ignore: ["**/*.test.ts"] };
    assert.deepEqual((await glob("src/*.{ts,tsx}", options)).sort(), [
      "src/model.ts",
      "src/view.tsx",
    ]);
    assert.deepEqual((await glob("src/*.{ts,tsx}", { ...options, dot: true })).sort(), [
      "src/.hidden.ts",
      "src/model.ts",
      "src/view.tsx",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
