import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Always-loaded agent instructions cost context in every task. Move detail
// into owning docs and link to it instead of raising a budget.
const BUDGETS = [
  ["AGENTS.md", 32 * 1024],
  ["packages/app/AGENTS.md", 8 * 1024],
];

for (const [file, limit] of BUDGETS) {
  test(`${file} stays within ${limit / 1024} KiB`, () => {
    const size = statSync(file).size;
    assert.ok(
      size <= limit,
      `${file} is ${size} bytes; the budget is ${limit}. Move detail to docs/.`,
    );
  });
}

test("CLAUDE.md stays a pointer to AGENTS.md", () => {
  if (!existsSync("CLAUDE.md")) return;
  if (lstatSync("CLAUDE.md").isSymbolicLink()) {
    assert.equal(readlinkSync("CLAUDE.md"), "AGENTS.md");
    return;
  }
  assert.ok(statSync("CLAUDE.md").size <= 512, "Edit AGENTS.md; CLAUDE.md only links to it");
});

test("relative links in AGENTS.md resolve", () => {
  const text = readFileSync("AGENTS.md", "utf8");
  const missing = [...text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^[a-z]+:/i.test(target))
    .filter((target) => !existsSync(path.resolve(target)));
  assert.deepEqual(missing, []);
});
