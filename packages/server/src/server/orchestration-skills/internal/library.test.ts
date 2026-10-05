import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SkillLibrary } from "./library";
import { inventorySkills } from "./inventory";
import type { SkillLibraryResult } from "@getpaseo/protocol/skill-library";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const source = {
  repository: "example/skills",
  revision: "a".repeat(40),
  directory: "skills/example",
};
function files(description = "Example skill") {
  return new Map([
    [
      "SKILL.md",
      Buffer.from(`---\nname: example\ndescription: ${description}\n---\nInstructions\n`),
    ],
  ]);
}
async function harness() {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-library-"));
  roots.push(home);
  const library = new SkillLibrary(path.join(home, "state"), home, async () => files());
  return { home, library, target: path.join(home, ".agents/skills/example") };
}
function previewId(result: SkillLibraryResult) {
  if (result.kind !== "preview") throw new Error("Expected preview");
  return result.preview.id;
}
it("installs a reviewed package, inventories provenance, removes and restores it", async () => {
  const { library, home, target } = await harness();
  const preview = await library.change({ kind: "preview_install", source });
  expect((await inventorySkills({ home })).skills).toEqual([]);
  await library.change({ kind: "apply", previewId: previewId(preview) });
  const inventory = await inventorySkills({ home });
  expect(inventory.skills[0]).toMatchObject({ name: "example", source, managed: true });
  const removal = await library.change({ kind: "preview_remove", id: inventory.skills[0].id });
  const removed = await library.change({ kind: "apply", previewId: previewId(removal) });
  if (removed.kind !== "applied") throw new Error("Expected applied");
  expect((await inventorySkills({ home })).skills).toEqual([]);
  const restore = await library.change({ kind: "preview_restore", auditId: removed.entry.id });
  await library.change({ kind: "apply", previewId: previewId(restore) });
  expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("Instructions");
});
it("refuses a stale preview without overwriting an intervening edit", async () => {
  const { library, target } = await harness();
  await library.change({
    kind: "apply",
    previewId: previewId(await library.change({ kind: "preview_install", source })),
  });
  const preview = await library.change({ kind: "preview_install", source });
  await writeFile(path.join(target, "notes.txt"), "User work");
  await expect(library.change({ kind: "apply", previewId: previewId(preview) })).rejects.toThrow(
    "changed since preview",
  );
  expect(await readFile(path.join(target, "notes.txt"), "utf8")).toBe("User work");
});
it("preserves unmanaged packages and provider packages", async () => {
  const { library, target, home } = await harness();
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), files().get("SKILL.md")!);
  await expect(library.change({ kind: "preview_install", source })).rejects.toThrow(
    "different owner",
  );
  const skill = (await inventorySkills({ home })).skills[0];
  await expect(library.change({ kind: "preview_remove", id: skill.id })).rejects.toThrow(
    "library-managed",
  );
});
it("consolidates only identical packages and retains the original for recovery", async () => {
  const { library, home, target } = await harness();
  await library.change({
    kind: "apply",
    previewId: previewId(await library.change({ kind: "preview_install", source })),
  });
  const duplicate = path.join(home, ".claude/skills/example");
  await mkdir(duplicate, { recursive: true });
  await writeFile(path.join(duplicate, "SKILL.md"), files().get("SKILL.md")!);
  const inventory = await inventorySkills({ home });
  const canonical = inventory.skills.find((entry) => entry.path === target)!;
  const other = inventory.skills.find((entry) => entry.path === duplicate)!;
  const preview = await library.change({
    kind: "preview_consolidate",
    id: other.id,
    canonicalId: canonical.id,
  });
  await library.change({ kind: "apply", previewId: previewId(preview) });
  expect(await realpath(duplicate)).toBe(await realpath(target));
  const history = await library.read({ kind: "audit" });
  expect(history.kind === "audit" && history.entries.length).toBe(2);
});

it("recovers an interrupted replacement before accepting another change", async () => {
  const { library, home, target } = await harness();
  await library.change({
    kind: "apply",
    previewId: previewId(await library.change({ kind: "preview_install", source })),
  });
  const pending = await library.change({ kind: "preview_install", source });
  if (pending.kind !== "preview") throw new Error("Expected preview");
  const state = path.join(home, "state");
  await writeFile(path.join(state, "pending.json"), JSON.stringify(pending.preview));
  await rename(target, path.join(state, "backups", pending.preview.id));
  const recovered = new SkillLibrary(state, home, async () => files());
  await recovered.change({ kind: "preview_install", source });
  expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("Instructions");
  await expect(readFile(path.join(state, "pending.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("keeps new local edits when interrupted recovery encounters a conflict", async () => {
  const { library, home, target } = await harness();
  const pending = await library.change({ kind: "preview_install", source });
  if (pending.kind !== "preview") throw new Error("Expected preview");
  await writeFile(path.join(home, "state/pending.json"), JSON.stringify(pending.preview));
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "notes.txt"), "New local work");
  await expect(library.change({ kind: "preview_install", source })).rejects.toThrow(
    "new local edits",
  );
  expect(await readFile(path.join(target, "notes.txt"), "utf8")).toBe("New local work");
});
it("refuses removal of a canonical package while another provider references it", async () => {
  const { library, home, target } = await harness();
  await library.change({
    kind: "apply",
    previewId: previewId(await library.change({ kind: "preview_install", source })),
  });
  await mkdir(path.join(home, ".claude/skills"), { recursive: true });
  await symlink(target, path.join(home, ".claude/skills/example"));
  const canonical = (await inventorySkills({ home })).skills.find(
    (skill) => skill.path === target,
  )!;
  await expect(library.change({ kind: "preview_remove", id: canonical.id })).rejects.toThrow(
    "discovery links",
  );
  expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("Instructions");
});

it("adds a reviewed provider link and retries committed operations idempotently", async () => {
  const { library, home, target } = await harness();
  const installId = previewId(await library.change({ kind: "preview_install", source }));
  const installed = await library.change({ kind: "apply", previewId: installId });
  expect(await library.change({ kind: "apply", previewId: installId })).toEqual(installed);
  const canonical = (await inventorySkills({ home })).skills[0];
  const link = await library.change({ kind: "preview_link", id: canonical.id, provider: "claude" });
  expect(link.kind === "preview" && link.preview.beforeHash).toBeNull();
  await library.change({ kind: "apply", previewId: previewId(link) });
  expect(await realpath(path.join(home, ".claude/skills/example"))).toBe(await realpath(target));
  await expect(
    library.change({ kind: "preview_link", id: canonical.id, provider: "claude" }),
  ).rejects.toThrow("already exists");
});

it("restores relative discovery links without resolving them from the backup directory", async () => {
  const { library, home, target } = await harness();
  await library.change({
    kind: "apply",
    previewId: previewId(await library.change({ kind: "preview_install", source })),
  });
  const canonical = (await inventorySkills({ home })).skills[0];
  await library.change({
    kind: "apply",
    previewId: previewId(
      await library.change({ kind: "preview_link", id: canonical.id, provider: "claude" }),
    ),
  });
  const alias = (await inventorySkills({ home })).skills.find((skill) =>
    skill.path.includes(".claude"),
  )!;
  const removed = await library.change({
    kind: "apply",
    previewId: previewId(await library.change({ kind: "preview_remove", id: alias.id })),
  });
  if (removed.kind !== "applied") throw new Error("Expected applied");
  await library.change({
    kind: "apply",
    previewId: previewId(
      await library.change({ kind: "preview_restore", auditId: removed.entry.id }),
    ),
  });
  expect(await realpath(alias.path)).toBe(await realpath(target));
});
