import path from "node:path";
import type { SkillSnapshot } from "@getpaseo/protocol/skill-library";
import { readPackage, SkillLibraryError } from "./inventory.js";

export interface NativeSkill {
  name: string;
  path: string;
}

/**
 * Maps a frozen skill selection onto the Codex session's native catalog.
 *
 * Each account-isolated Codex session uses its own CODEX_HOME, so provider skills such as
 * `.system/imagegen` are listed from that home while the snapshot recorded the copy the daemon
 * inventoried. A catalog entry at another path still satisfies the selection when it has the
 * same name and byte-identical package content; anything else stays undiscovered.
 */
export async function codexSkillFilter(snapshot: SkillSnapshot, catalog: NativeSkill[]) {
  const paths = new Set<string>();
  for (const skill of snapshot.skills) {
    const exact = path.join(skill.path, "SKILL.md");
    if (catalog.some((entry) => entry.path === exact)) {
      paths.add(exact);
      continue;
    }
    const copies = await equivalentCopies(skill, catalog);
    if (!copies.length)
      throw new SkillLibraryError(
        "undiscovered_skill",
        `Provider did not discover selected skill ${skill.name}`,
      );
    for (const copy of copies) paths.add(copy);
  }
  return catalog.map((entry) => ({ path: entry.path, enabled: paths.has(entry.path) }));
}

async function equivalentCopies(
  skill: SkillSnapshot["skills"][number],
  catalog: NativeSkill[],
): Promise<string[]> {
  const copies: string[] = [];
  for (const entry of catalog) {
    if (entry.name !== skill.name || path.basename(entry.path) !== "SKILL.md") continue;
    const hash = await readPackage(path.dirname(entry.path)).then(
      (pkg) => pkg.hash,
      () => null,
    );
    if (hash === skill.sha256) copies.push(entry.path);
  }
  return copies;
}
