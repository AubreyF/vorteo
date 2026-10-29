// Rewrites records for checkouts that moved, such as a project directory renamed from
// ~/dev/paseo to ~/dev/vorteo. Runs at startup before agent storage and the registries
// load. Covers workspace paths and membership keys, project roots, and agent working
// directories, including the provider resume metadata. Agent files move to the directory
// storage derives from the new path. Idempotent: once nothing sits under a `from` path it
// changes nothing. Registry files and every moved agent file are copied first.
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { writeFileAtomic } from "../atomic-file.js";
import { projectDirNameFromCwd } from "../agent/agent-storage.js";
import type { MovedPath } from "../projects-folder.js";
import { toLogicalProjectKey, toLogicalProjectsPath } from "../projects-folder.js";

const WORKSPACE_PATH_FIELDS = ["cwd", "worktreeRoot", "mainRepoRoot"] as const;

export interface MovedPathsMigrationInput {
  paseoHome: string;
  agentStoragePath: string;
  moves: readonly MovedPath[];
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
}

export interface MovedPathsMigrationResult {
  projects: number;
  workspaces: number;
  agents: number;
  /** Archived projects left in place because their new root already belongs to a project. */
  skippedProjects: number;
  backupDirectory: string | null;
}

type RegistryRecord = Record<string, unknown>;

function rewrite(value: unknown, moves: readonly MovedPath[]): string | null {
  if (typeof value !== "string") return null;
  for (const move of moves) {
    const next = toLogicalProjectsPath({ root: move.to, aliases: [move.from] }, value);
    if (next !== value) return next;
  }
  return null;
}

function rewriteKey(value: unknown, moves: readonly MovedPath[]): string | null {
  if (typeof value !== "string") return null;
  for (const move of moves) {
    const next = toLogicalProjectKey({ root: move.to, aliases: [move.from] }, value);
    if (next !== value) return next;
  }
  return null;
}

function isRecord(value: unknown): value is RegistryRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readList(file: string): Promise<RegistryRecord[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file} does not hold a registry list`);
  // Rewriting the list must not drop entries it cannot read, so refuse instead.
  if (!parsed.every(isRecord)) throw new Error(`${file} holds an entry that is not a record`);
  return parsed;
}

function rewriteWorkspace(record: RegistryRecord, moves: readonly MovedPath[]) {
  let next: RegistryRecord | null = null;
  for (const field of WORKSPACE_PATH_FIELDS) {
    const value = rewrite(record[field], moves);
    if (value) next = { ...(next ?? record), [field]: value };
  }
  const membership = record.projectMembership;
  if (isRecord(membership)) {
    const key = rewriteKey(membership.key, moves);
    if (key) next = { ...(next ?? record), projectMembership: { ...membership, key } };
  }
  return next;
}

// Two projects must not share a root. An archived project whose new root already belongs to
// another project keeps its recorded path; its workspaces still move.
function rewriteProjects(records: RegistryRecord[], moves: readonly MovedPath[]) {
  const roots = new Set(records.map((record) => record.rootPath).filter(Boolean));
  let changed = 0;
  let skipped = 0;
  const next = records.map((record) => {
    const rootPath = rewrite(record.rootPath, moves);
    const projectKey = rewriteKey(record.projectKey, moves);
    if (!rootPath && !projectKey) return record;
    if (rootPath && roots.has(rootPath)) {
      skipped += 1;
      return record;
    }
    changed += 1;
    return {
      ...record,
      ...(rootPath ? { rootPath } : {}),
      ...(projectKey ? { projectKey } : {}),
    };
  });
  return { records: next, changed, skipped };
}

interface AgentMove {
  from: string;
  to: string;
  record: RegistryRecord;
  content: string;
  /** An interrupted earlier run already wrote exactly this content to `to`. */
  targetWritten: boolean;
}

async function planAgentMoves(
  agentStoragePath: string,
  moves: readonly MovedPath[],
): Promise<AgentMove[]> {
  let directories: string[];
  try {
    directories = (await fs.readdir(agentStoragePath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const planned: AgentMove[] = [];
  for (const directory of directories) {
    const folder = path.join(agentStoragePath, directory);
    for (const name of await fs.readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(folder, name);
      let record: unknown;
      try {
        record = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        continue; // Agent storage reports and skips invalid records itself.
      }
      if (!isRecord(record)) continue;
      const cwd = rewrite(record.cwd, moves);
      if (!cwd) continue;
      let next: RegistryRecord = { ...record, cwd };
      const persistence = record.persistence;
      if (isRecord(persistence) && isRecord(persistence.metadata)) {
        const resumeCwd = rewrite(persistence.metadata.cwd, moves);
        if (resumeCwd) {
          next = {
            ...next,
            persistence: {
              ...persistence,
              metadata: { ...persistence.metadata, cwd: resumeCwd },
            },
          };
        }
      }
      planned.push({
        from: file,
        to: path.join(agentStoragePath, projectDirNameFromCwd(cwd), name),
        record: next,
        content: JSON.stringify(next, null, 2),
        targetWritten: false,
      });
    }
  }
  return checkAgentTargets(planned);
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Never overwrite an agent file. A target holding exactly the planned content is the
// write of an interrupted earlier run, which resumes by removing the source. Any other
// existing target, or two sources for one target, refuses the whole migration before
// anything is written.
async function checkAgentTargets(planned: AgentMove[]): Promise<AgentMove[]> {
  const targets = new Set<string>();
  for (const agent of planned) {
    if (targets.has(agent.to)) throw new Error(`Two agent records would move to ${agent.to}`);
    targets.add(agent.to);
    if (agent.to === agent.from) continue;
    const existing = await readIfExists(agent.to);
    if (existing === null) continue;
    if (existing !== agent.content)
      throw new Error(`A different agent record already exists at ${agent.to}`);
    agent.targetWritten = true;
  }
  return planned;
}

interface PlannedWrite {
  /** The existing file, backed up under `backup` before anything is written. */
  source: string;
  backup: string;
  target: string;
  content: string;
  /** The target already holds `content`; only the source remains to remove. */
  targetWritten?: boolean;
}

function normalizeMoves(moves: readonly MovedPath[]): MovedPath[] {
  return moves
    .map((move) => ({ from: move.from.replace(/\/+$/u, ""), to: move.to.replace(/\/+$/u, "") }))
    .filter((move) => move.from && move.to && move.from !== move.to);
}

// Copy every source first, so a failure part-way leaves a complete earlier state.
async function applyWrites(writes: readonly PlannedWrite[], backupDirectory: string) {
  for (const write of writes) {
    const backup = path.join(backupDirectory, write.backup);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(write.source, backup);
  }
  for (const write of writes) {
    if (!write.targetWritten) {
      await fs.mkdir(path.dirname(write.target), { recursive: true });
      await writeFileAtomic(write.target, write.content);
    }
    if (write.target !== write.source) await fs.rm(write.source, { force: true });
  }
}

export async function migrateMovedPaths(
  input: MovedPathsMigrationInput,
): Promise<MovedPathsMigrationResult> {
  const result: MovedPathsMigrationResult = {
    projects: 0,
    workspaces: 0,
    agents: 0,
    skippedProjects: 0,
    backupDirectory: null,
  };
  const moves = normalizeMoves(input.moves);
  if (moves.length === 0) return result;

  const projectsFile = path.join(input.paseoHome, "projects", "projects.json");
  const workspacesFile = path.join(input.paseoHome, "projects", "workspaces.json");
  const [projects, workspaces, agents] = await Promise.all([
    readList(projectsFile),
    readList(workspacesFile),
    planAgentMoves(input.agentStoragePath, moves),
  ]);

  const writes: PlannedWrite[] = [];
  const projectUpdate = projects ? rewriteProjects(projects, moves) : null;
  result.skippedProjects = projectUpdate?.skipped ?? 0;
  if (projectUpdate?.changed) {
    result.projects = projectUpdate.changed;
    const content = JSON.stringify(projectUpdate.records, null, 2);
    writes.push({ source: projectsFile, backup: "projects.json", target: projectsFile, content });
  }
  const workspaceRecords = (workspaces ?? []).map((record) => {
    const next = rewriteWorkspace(record, moves);
    if (next) result.workspaces += 1;
    return next ?? record;
  });
  if (result.workspaces > 0) {
    const content = JSON.stringify(workspaceRecords, null, 2);
    writes.push({
      source: workspacesFile,
      backup: "workspaces.json",
      target: workspacesFile,
      content,
    });
  }
  for (const agent of agents) {
    writes.push({
      source: agent.from,
      backup: path.join("agents", path.relative(input.agentStoragePath, agent.from)),
      target: agent.to,
      content: agent.content,
      targetWritten: agent.targetWritten,
    });
  }
  result.agents = agents.length;

  if (writes.length === 0) {
    if (result.skippedProjects > 0)
      input.logger.warn({ moves, ...result }, "Left archived projects at their moved paths");
    return result;
  }
  const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  result.backupDirectory = path.join(input.paseoHome, "backups", `moved-paths-${stamp}`);
  await applyWrites(writes, result.backupDirectory);
  input.logger.info({ moves, ...result }, "Moved records for relocated checkouts");
  return result;
}
