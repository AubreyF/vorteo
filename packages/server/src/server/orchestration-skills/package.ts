import type { SkillPackage } from "@getpaseo/protocol/skill-library";
import {
  MAX_PACKAGE_BYTES,
  RECEIPT,
  packageHash,
  skillMetadata,
  SkillLibraryError,
  type SkillFiles,
} from "./internal/inventory.js";

function relativeName(value: string): boolean {
  return value
    .split("/")
    .every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== ".." && part !== ".");
}

export function decodeSkillPackage(pkg: SkillPackage): SkillFiles {
  const files: SkillFiles = new Map();
  files.executables = new Set();
  let bytes = 0;
  for (const entry of pkg.files) {
    if (
      !relativeName(entry.path) ||
      [RECEIPT, ".paseo-managed-files.json"].includes(entry.path) ||
      files.has(entry.path)
    )
      throw new SkillLibraryError("unsafe_package", "Package contains unsafe or duplicate paths");
    const content = Buffer.from(entry.content, "base64");
    if (content.toString("base64") !== entry.content)
      throw new SkillLibraryError("unsafe_package", "Package contains invalid encoded content");
    bytes += content.length;
    if (bytes > MAX_PACKAGE_BYTES)
      throw new SkillLibraryError("package_limit", "Skill exceeds size limit");
    files.set(entry.path, content);
    if (entry.executable) files.executables.add(entry.path);
  }
  if (packageHash(files) !== pkg.sha256)
    throw new SkillLibraryError("conflict", "Package content does not match its reviewed hash");
  const instructions = files.get("SKILL.md");
  if (!instructions) throw new SkillLibraryError("metadata", "Package has no SKILL.md");
  skillMetadata(instructions);
  return files;
}
