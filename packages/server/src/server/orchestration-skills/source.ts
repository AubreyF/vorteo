import { z } from "zod";
import { SkillSourceSchema, type SkillSource } from "@getpaseo/protocol/skill-library";
import {
  MAX_FILES,
  MAX_PACKAGE_BYTES,
  RECEIPT,
  skillMetadata,
  SkillLibraryError,
  type SkillFiles,
} from "./internal/inventory.js";

const Tree = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({ path: z.string(), type: z.string(), mode: z.string(), size: z.number().optional() }),
  ),
});
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function relativeName(value: string): boolean {
  return value.split("/").every((part) => safeName.test(part) && part !== ".." && part !== ".");
}
async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new SkillLibraryError("download", `Source request failed (${response.status})`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (!response.body) throw new SkillLibraryError("download", "Source response has no body");
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      length += chunk.length;
      if (length > MAX_PACKAGE_BYTES)
        throw new SkillLibraryError("package_limit", "Source response exceeds limit");
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export async function downloadSkill(input: SkillSource): Promise<SkillFiles> {
  const source = SkillSourceSchema.parse(input);
  const parts = source.repository.split("/");
  if (
    parts.length !== 2 ||
    !parts.every((part) => safeName.test(part)) ||
    !relativeName(source.directory)
  )
    throw new SkillLibraryError("source", "Use an owner/repository and a relative skill directory");
  const tree = Tree.parse(
    JSON.parse(
      (
        await fetchBytes(
          `https://api.github.com/repos/${source.repository}/git/trees/${source.revision}?recursive=1`,
        )
      ).toString("utf8"),
    ),
  );
  if (tree.truncated) throw new SkillLibraryError("source", "Repository tree is incomplete");
  const prefix = `${source.directory}/`;
  const entries = tree.tree.filter(
    (entry) => entry.path.startsWith(prefix) && entry.type !== "tree",
  );
  if (entries.length > MAX_FILES)
    throw new SkillLibraryError("package_limit", "Too many skill files");
  const files: SkillFiles = new Map<string, Buffer>();
  files.executables = new Set();
  let bytes = 0;
  for (const entry of entries) {
    const name = entry.path.slice(prefix.length);
    if (
      !relativeName(name) ||
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      name === RECEIPT
    )
      throw new SkillLibraryError("unsafe_package", "Source contains unsupported paths or links");
    const content = await fetchBytes(
      `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${entry.path}`,
    );
    bytes += content.length;
    if (bytes > MAX_PACKAGE_BYTES)
      throw new SkillLibraryError("package_limit", "Skill exceeds size limit");
    files.set(name, content);
    if (entry.mode === "100755") files.executables.add(name);
  }
  const instructions = files.get("SKILL.md");
  if (!instructions) throw new SkillLibraryError("metadata", "Source directory has no SKILL.md");
  skillMetadata(instructions);
  return files;
}
