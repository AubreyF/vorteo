import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const braces = require("braces");
const nested = "{".repeat(4000) + "a,b" + "}".repeat(4000);
const depthError = { name: "SyntaxError", message: "Brace pattern nesting exceeds limit (128)" };

for (const method of ["parse", "compile", "expand", "stringify"]) {
  test(`${method} rejects excessive string nesting before recursive traversal`, () => {
    assert.throws(() => braces[method](nested), depthError);
    assert.throws(() => braces[method]("(".repeat(4000) + "a" + ")".repeat(4000)), depthError);
    assert.throws(() => braces[method]("{".repeat(4000) + "a"), depthError);
  });
}

for (const method of ["compile", "expand", "stringify"]) {
  test(`${method} also bounds externally supplied syntax trees`, () => {
    let ast = { type: "root", nodes: [] };
    for (let i = 0; i < 200; i++) ast = { type: "root", nodes: [ast] };
    assert.throws(() => braces[method](ast), depthError);
  });
}

test("ordinary brace syntax, escaping and literal brackets retain their behavior", () => {
  assert.deepEqual(braces.expand("src/{a,{b,c}}.{ts,tsx}"), [
    "src/a.ts",
    "src/a.tsx",
    "src/b.ts",
    "src/b.tsx",
    "src/c.ts",
    "src/c.tsx",
  ]);
  assert.deepEqual(braces.expand("file{01..03}.ts"), ["file01.ts", "file02.ts", "file03.ts"]);
  assert.equal(braces.compile("src/{a,b}.ts"), "src/(a|b).ts");
  assert.equal(braces.stringify(braces.parse("src/{a,b}.ts")), "src/{a,b}.ts");
  assert.deepEqual(braces.expand("\\{".repeat(200)), ["{".repeat(200)]);
  assert.deepEqual(braces.expand('"' + "{".repeat(200) + '"'), ["{".repeat(200)]);
  assert.deepEqual(braces.expand("[" + "{".repeat(200) + "]"), ["[" + "{".repeat(200) + "]"]);
  assert.deepEqual(braces.expand("{".repeat(32) + "a,b" + "}".repeat(32)), [
    "{".repeat(31) + "a" + "}".repeat(31),
    "{".repeat(31) + "b" + "}".repeat(31),
  ]);
});

test("file-discovery consumers reject deep patterns through the patched parser", () => {
  assert.throws(() => require("fast-glob").generateTasks(nested), depthError);
  assert.throws(() => require("micromatch").braces(nested, { expand: true }), depthError);
});
