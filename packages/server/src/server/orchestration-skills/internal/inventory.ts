import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  SkillSourceSchema,
  type SkillInstallation,
  type SkillInventory,
} from "@getpaseo/protocol/skill-library";

const Metadata = z.object({ name: z.string().min(1), description: z.string().min(1) });
export const RECEIPT = ".vorteo-skill-source.json";
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 256;
export interface SkillRoot {
  path: string;
  owner: SkillInstallation["owner"];
  providers: string[];
  depth: number;
}
export interface SkillFiles extends Map<string, Buffer> {
  executables?: Set<string>;
}
export interface SkillPackage {
  files: SkillFiles;
  hash: string;
}
export class SkillLibraryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillLibraryError";
  }
}
export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function packageHash(files: SkillFiles): string {
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  return digest(
    JSON.stringify(
      entries.map(([name, bytes]) => [name, digest(bytes), files.executables?.has(name) === true]),
    ),
  );
}
export async function readPackage(directory: string): Promise<SkillPackage> {
  const files: SkillFiles = new Map<string, Buffer>();
  files.executables = new Set();
  let size = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(directory, full);
      if (entry.isSymbolicLink())
        throw new SkillLibraryError("unsafe_package", `Linked package file: ${rel}`);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile())
        throw new SkillLibraryError("unsafe_package", `Unsupported package file: ${rel}`);
      if (rel === RECEIPT || rel === ".paseo-managed-files.json") continue;
      const stat = await fs.stat(full);
      size += stat.size;
      if (size > MAX_PACKAGE_BYTES || files.size >= MAX_FILES)
        throw new SkillLibraryError("package_limit", "Skill exceeds inspection limits");
      const name = rel.split(path.sep).join("/");
      if (stat.mode & 0o111) files.executables!.add(name);
      files.set(name, await fs.readFile(full));
    }
  }
  await walk(directory);
  return { files, hash: packageHash(files) };
}
export function skillMetadata(bytes: Buffer) {
  const text = bytes.toString("utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match)
    throw new SkillLibraryError("metadata", "SKILL.md needs name and description frontmatter");
  return Metadata.parse(parse(match[1]));
}
export async function skillRoots(home: string, cwd?: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [
    { path: path.join(home, ".agents/skills"), owner: "personal", providers: ["codex"], depth: 2 },
    { path: path.join(home, ".claude/skills"), owner: "personal", providers: ["claude"], depth: 2 },
    { path: path.join(home, ".codex/skills"), owner: "personal", providers: ["codex"], depth: 2 },
    {
      path: path.join(home, ".codex/plugins/cache"),
      owner: "plugin",
      providers: ["codex"],
      depth: 7,
    },
    {
      path: path.join(home, ".claude/plugins/cache"),
      owner: "plugin",
      providers: ["claude"],
      depth: 7,
    },
    {
      path: path.join(home, ".local/share/vorteo-host/skills"),
      owner: "vorteo",
      providers: [],
      depth: 2,
    },
  ];
  if (cwd) {
    let current = path.resolve(cwd);
    for (;;) {
      for (const provider of ["agents", "codex", "claude"]) {
        roots.push({
          path: path.join(current, `.${provider}/skills`),
          owner: "project",
          providers: [provider === "agents" ? "codex" : provider],
          depth: 2,
        });
      }
      const git = await fs.lstat(path.join(current, ".git")).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (git || path.dirname(current) === current) break;
      current = path.dirname(current);
    }
  }
  return roots;
}
export async function inspectSkill(directory: string, root: SkillRoot): Promise<SkillInstallation> {
  const result: SkillInstallation = {
    id: digest(directory),
    identity: `local:${digest(directory)}`,
    name: path.basename(directory),
    description: "",
    path: directory,
    resolvedPath: null,
    owner: root.owner,
    providers: root.providers,
    sha256: null,
    files: [],
    issues: [],
    source: null,
    managed: false,
    discovery: "filesystem",
  };
  if (directory.includes(`${path.sep}.system${path.sep}`)) result.owner = "provider";
  try {
    result.resolvedPath = await fs.realpath(directory);
    if (result.resolvedPath.includes(`${path.sep}.system${path.sep}`)) result.owner = "provider";
    if (result.resolvedPath.includes(`${path.sep}plugins${path.sep}cache${path.sep}`))
      result.owner = "plugin";
    const pkg = await readPackage(result.resolvedPath);
    result.sha256 = pkg.hash;
    result.identity = `content:${pkg.hash}`;
    result.files = [...pkg.files].map(([name, bytes]) => ({
      path: name,
      sha256: digest(bytes),
      bytes: bytes.length,
    }));
    const skill = pkg.files.get("SKILL.md");
    if (!skill) throw new SkillLibraryError("metadata", "Missing SKILL.md");
    Object.assign(result, skillMetadata(skill));
    const receipt = await fs
      .readFile(path.join(directory, RECEIPT), "utf8")
      .catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
    if (receipt) {
      result.source = SkillSourceSchema.parse(JSON.parse(receipt));
      result.identity = `github:${result.source.repository}/${result.source.directory}`;
      result.managed = result.owner === "personal";
    }
    const managed = await fs
      .stat(path.join(directory, ".paseo-managed-files.json"))
      .catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
    if (managed || result.name === "installation-maintenance") {
      result.owner = "vorteo";
      result.managed = false;
    }
  } catch (error) {
    result.issues.push(error instanceof Error ? error.message : "Inspection failed");
  }
  return result;
}
export async function inventorySkills(
  options: { home?: string; cwd?: string } = {},
): Promise<SkillInventory> {
  const roots = await skillRoots(options.home ?? os.homedir(), options.cwd);
  const inventory: SkillInventory = {
    observedAt: new Date().toISOString(),
    skills: [],
    roots: [],
    limitations: [
      "Filesystem observations do not prove provider discovery, activation, or invocation.",
      "Project skills are included only for the requested working directory. Remote and account-specific provider catalogs are not inferred.",
      "Dependencies and credential readiness require provider diagnostics; secret values are never inspected.",
    ],
  };
  const seen = new Set<string>();
  for (const root of roots) {
    try {
      await walk(root.path, root.depth, root);
      inventory.roots.push({ path: root.path, status: "scanned", error: null });
    } catch (error) {
      inventory.roots.push({
        path: root.path,
        status: missing(error) ? "missing" : "error",
        error: missing(error) ? null : String(error),
      });
    }
  }
  async function walk(directory: string, depth: number, root: SkillRoot): Promise<void> {
    if (seen.has(directory)) return;
    seen.add(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === "SKILL.md")) {
      inventory.skills.push(await inspectSkill(directory, root));
      return;
    }
    if (depth <= 0) return;
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const full = path.join(directory, entry.name);
        try {
          await walk(full, depth - 1, root);
        } catch (error) {
          inventory.roots.push({ path: full, status: "error", error: String(error) });
        }
      }
    }
  }
  return inventory;
}
