// Rewrites registry paths recorded under an earlier location of the Projects folder, such
// as a Dev container that mounted ~/dev at another user's home, to the folder's current
// identical path. Runs at startup before the registries load. Idempotent: once no record
// starts with an earlier prefix it changes nothing. Each changed file is copied first.
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { writeFileAtomic } from "../atomic-file.js";

const PROJECT_PATH_FIELDS = ["rootPath"] as const;
const WORKSPACE_PATH_FIELDS = ["cwd", "worktreeRoot", "mainRepoRoot"] as const;
const LOCAL_KEY_PREFIX = /^(host:[^:]+:)?(\/.*)$/u;

export interface ProjectsFolderPathMigrationInput {
  paseoHome: string;
  root: string;
  migrateFrom: readonly string[];
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
}

export interface ProjectsFolderPathMigrationResult {
  projects: number;
  workspaces: number;
  backups: string[];
}

function rewritePath(value: unknown, root: string, prefixes: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  for (const prefix of prefixes) {
    if (value === prefix) return root;
    if (value.startsWith(`${prefix}/`)) return path.posix.join(root, value.slice(prefix.length));
  }
  return null;
}

// Local project keys embed the path (`host:<serverId>:<path>` or a bare path); remote keys do not.
function rewriteProjectKey(value: unknown, root: string, prefixes: readonly string[]) {
  if (typeof value !== "string") return null;
  const match = LOCAL_KEY_PREFIX.exec(value);
  if (!match) return null;
  const rewritten = rewritePath(match[2], root, prefixes);
  return rewritten ? `${match[1] ?? ""}${rewritten}` : null;
}

type RegistryRecord = Record<string, unknown>;

function rewriteRecords(
  records: RegistryRecord[],
  fields: readonly string[],
  root: string,
  prefixes: readonly string[],
  extra?: (record: RegistryRecord) => RegistryRecord | null,
): { records: RegistryRecord[]; changed: number } {
  let changed = 0;
  const next = records.map((record) => {
    let updated: RegistryRecord | null = null;
    for (const field of fields) {
      const rewritten = rewritePath(record[field], root, prefixes);
      if (rewritten) updated = { ...(updated ?? record), [field]: rewritten };
    }
    const extraUpdate = extra?.(updated ?? record) ?? null;
    if (extraUpdate) updated = extraUpdate;
    if (updated) changed += 1;
    return updated ?? record;
  });
  return { records: next, changed };
}

async function readRecords(file: string): Promise<RegistryRecord[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file} does not hold a registry list`);
  return parsed.filter(
    (entry): entry is RegistryRecord => Boolean(entry) && typeof entry === "object",
  );
}

export async function migrateRegistryPathsToProjectsFolder(
  input: ProjectsFolderPathMigrationInput,
): Promise<ProjectsFolderPathMigrationResult> {
  const prefixes = input.migrateFrom
    .map((prefix) => prefix.replace(/\/+$/u, ""))
    .filter((prefix) => prefix && prefix !== input.root);
  const result: ProjectsFolderPathMigrationResult = { projects: 0, workspaces: 0, backups: [] };
  if (prefixes.length === 0) return result;

  const directory = path.join(input.paseoHome, "projects");
  const projectsFile = path.join(directory, "projects.json");
  const workspacesFile = path.join(directory, "workspaces.json");
  const [projects, workspaces] = await Promise.all([
    readRecords(projectsFile),
    readRecords(workspacesFile),
  ]);

  const projectUpdate = projects
    ? rewriteRecords(projects, PROJECT_PATH_FIELDS, input.root, prefixes, (record) => {
        const projectKey = rewriteProjectKey(record.projectKey, input.root, prefixes);
        return projectKey ? { ...record, projectKey } : null;
      })
    : null;
  const workspaceUpdate = workspaces
    ? rewriteRecords(workspaces, WORKSPACE_PATH_FIELDS, input.root, prefixes)
    : null;

  const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  const writes: Array<[string, RegistryRecord[]]> = [];
  if (projectUpdate?.changed) writes.push([projectsFile, projectUpdate.records]);
  if (workspaceUpdate?.changed) writes.push([workspacesFile, workspaceUpdate.records]);
  // Back up every file first, so a failure part-way leaves a complete copy of both.
  for (const [file] of writes) {
    const backup = `${file}.before-projects-folder-${stamp}`;
    await fs.copyFile(file, backup);
    result.backups.push(backup);
  }
  for (const [file, records] of writes) {
    await writeFileAtomic(file, JSON.stringify(records, null, 2));
  }
  result.projects = projectUpdate?.changed ?? 0;
  result.workspaces = workspaceUpdate?.changed ?? 0;
  if (writes.length > 0) {
    input.logger.info(
      { ...result, root: input.root, migrateFrom: prefixes },
      "Moved registry paths into the Projects folder",
    );
  }
  return result;
}
