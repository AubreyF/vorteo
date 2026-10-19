import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const formatter = createRequire(new URL("../node_modules/oxfmt/package.json", import.meta.url));
const { default: Tinypool } = await import(pathToFileURL(formatter.resolve("tinypool")).href);

test("formatter worker ignores an inherited task filename", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "formatter-worker-"));
  const filename = path.join(directory, "expected.mjs");
  const alternate = path.join(directory, "alternate.mjs");
  await writeFile(
    filename,
    "export function formatFile(value) { return {worker:'expected', value}; }",
  );
  await writeFile(
    alternate,
    "export function formatFile(value) { return {worker:'alternate', value}; }",
  );
  const pool = new Tinypool({ filename, minThreads: 1, maxThreads: 1, runtime: "child_process" });
  try {
    const options = Object.assign(Object.create({ filename: alternate }), { name: "formatFile" });
    assert.deepEqual(await pool.run("synthetic", options), {
      worker: "expected",
      value: "synthetic",
    });
  } finally {
    await pool.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
