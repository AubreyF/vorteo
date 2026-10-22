import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";

import {
  createPersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../workspace-registry.js";
import { generateWorkspaceId } from "../workspace-registry-model.js";
import { readSystemProjectConfig } from "./config.js";
import { SYSTEM_PROJECT_KIND, systemPaths } from "./manifest.js";

const execFileAsync = promisify(execFile);

/** Branch the clone starts on, at the configured ref. Operators branch their own work from it. */
export const SYSTEM_SOURCE_BRANCH = "local";
export const SYSTEM_SOURCE_TITLE = "Vorteo source";

export type RunGit = (args: string[], cwd?: string) => Promise<void>;

export interface SetupSystemSourceInput {
  paseoHome: string;
  projectRegistry: Pick<ProjectRegistry, "list" | "update">;
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "upsert">;
  logger: Logger;
  runGit?: RunGit;
  now?: () => string;
}

export interface SetupSystemSourceResult {
  outcome: "cloned" | "already_set_up";
  workspaceId: string;
}

const inFlight = new Map<string, Promise<SetupSystemSourceResult>>();

/**
 * Clones Vorteo source into the System project's root, on operator request.
 * The repository and ref come only from the operator's settings file, so a
 * client can never make the daemon clone something else.
 */
export function setupSystemSource(input: SetupSystemSourceInput): Promise<SetupSystemSourceResult> {
  const pending = inFlight.get(input.paseoHome);
  if (pending) return pending;
  const run = setupUnlocked(input).finally(() => inFlight.delete(input.paseoHome));
  inFlight.set(input.paseoHome, run);
  return run;
}

async function setupUnlocked(input: SetupSystemSourceInput): Promise<SetupSystemSourceResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const runGit = input.runGit ?? defaultRunGit;
  const paths = systemPaths(input.paseoHome);
  const project = (await input.projectRegistry.list()).find(
    (candidate) => candidate.systemProject?.kind === SYSTEM_PROJECT_KIND && !candidate.archivedAt,
  );
  if (!project)
    throw new Error("This host has no Vorteo System project yet. Restart it to create one.");
  const config = await readSystemProjectConfig(paths.config, input.logger);
  const source = config.source;

  if (!existsSync(path.join(paths.source, ".git"))) {
    if (!source) {
      throw new Error(
        "No Vorteo source is configured for this host. Add source.repository to the Vorteo System settings file.",
      );
    }
    await fs.mkdir(paths.source, { recursive: true });
    if ((await fs.readdir(paths.source)).length > 0)
      throw new Error("The Vorteo source folder is not empty, so it was left alone.");
    try {
      await runGit(["clone", "--", source.repository, paths.source]);
      await runGit(
        ["checkout", "-B", SYSTEM_SOURCE_BRANCH, ...(source.ref ? [source.ref] : [])],
        paths.source,
      );
    } catch (error) {
      // The folder was empty before this attempt, so clearing it loses nothing.
      await fs.rm(paths.source, { recursive: true, force: true });
      await fs.mkdir(paths.source, { recursive: true });
      throw new Error(`Could not clone Vorteo source: ${gitMessage(error)}`, { cause: error });
    }
    input.logger.info(
      { repository: source.repository, ref: source.ref ?? null },
      "Vorteo source cloned into the System project",
    );
  }

  // The project's key and marker stay pinned; only its kind follows the new checkout.
  await input.projectRegistry.update(project.projectId, (current) => ({
    ...current,
    kind: "git",
    updatedAt: now(),
  }));

  const existing = (await input.workspaceRegistry.list()).find(
    (workspace) =>
      !workspace.archivedAt &&
      workspace.projectId === project.projectId &&
      path.resolve(workspace.cwd) === path.resolve(paths.source),
  );
  if (existing) return { outcome: "already_set_up", workspaceId: existing.workspaceId };

  const timestamp = now();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: generateWorkspaceId(),
    projectId: project.projectId,
    cwd: paths.source,
    kind: "local_checkout",
    displayName: SYSTEM_SOURCE_BRANCH,
    title: SYSTEM_SOURCE_TITLE,
    branch: SYSTEM_SOURCE_BRANCH,
    worktreeRoot: paths.source,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  // An ordinary operator workspace: archive it and set up again to start over.
  await input.workspaceRegistry.upsert(workspace);
  return { outcome: "cloned", workspaceId: workspace.workspaceId };
}

async function defaultRunGit(args: string[], cwd?: string): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    timeout: 10 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : String(error);
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 500);
}
