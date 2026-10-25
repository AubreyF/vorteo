import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ensureFreshDeclarations, staleTargets, TARGETS } from "./ensure-fresh-declarations.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository with every source and output folder, stamped at `stampedAt` seconds. */
function fixture(stampedAt) {
  const root = mkdtempSync(path.join(tmpdir(), "fresh-declarations-"));
  roots.push(root);
  for (const target of TARGETS) {
    for (const source of target.sources) {
      mkdirSync(path.join(root, source), { recursive: true });
      const file = path.join(root, source, "index.ts");
      writeFileSync(file, "export {};\n");
      utimesSync(file, 100, 100);
    }
    mkdirSync(path.join(root, target.stamp), { recursive: true });
    if (stampedAt !== undefined) {
      const stamp = path.join(root, target.stamp, ".vorteo-build-stamp");
      writeFileSync(stamp, "stamp\n");
      utimesSync(stamp, stampedAt, stampedAt);
    }
  }
  return root;
}

const touch = (root, source) => {
  const file = path.join(root, source, "changed.ts");
  writeFileSync(file, "export const changed = 1;\n");
  utimesSync(file, 500, 500);
};

test("nothing is rebuilt when every build is newer than its sources", () => {
  const root = fixture(200);
  const runs = [];
  expect(ensureFreshDeclarations(root, (script) => runs.push(script))).toEqual([]);
  expect(runs).toEqual([]);
});

test("a changed client or relay source rebuilds the client chain once", () => {
  const root = fixture(200);
  touch(root, "packages/relay/src");
  expect(staleTargets(root)).toEqual(["client"]);
  const runs = [];
  expect(ensureFreshDeclarations(root, (script) => runs.push(script))).toEqual(["client"]);
  expect(runs).toEqual(["build:client"]);
  // Both stamps are fresh afterwards, so the next commit rebuilds nothing.
  expect(staleTargets(root)).toEqual([]);
});

test("a changed protocol source rebuilds through the client, which covers protocol", () => {
  const root = fixture(200);
  touch(root, "packages/protocol/src");
  expect(staleTargets(root)).toEqual(["protocol", "client"]);
  const runs = [];
  ensureFreshDeclarations(root, (script) => runs.push(script));
  expect(runs).toEqual(["build:client"]);
  expect(staleTargets(root)).toEqual([]);
});

test("a missing stamp counts as stale", () => {
  const root = fixture(undefined);
  expect(staleTargets(root)).toEqual(["protocol", "client"]);
});
