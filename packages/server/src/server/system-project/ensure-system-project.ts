import { promises as fs } from "node:fs";
import type { Logger } from "pino";

import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../workspace-registry.js";
import { generateProjectId, generateWorkspaceId } from "../workspace-registry-model.js";
import { readSystemProjectConfig } from "./config.js";
import {
  SYSTEM_PROJECT_KIND,
  SYSTEM_PROJECT_NAME,
  rolesForEnvironment,
  systemPaths,
  type SystemEnvironment,
  type SystemRole,
} from "./manifest.js";

type SystemProjectRegistry = Pick<ProjectRegistry, "list"> &
  Required<Pick<ProjectRegistry, "writeSystemProject">>;
type SystemWorkspaceRegistry = Pick<WorkspaceRegistry, "list"> &
  Required<Pick<WorkspaceRegistry, "writeSystemWorkspace">>;

export interface EnsureSystemProjectInput {
  paseoHome: string;
  serverId: string;
  environment: SystemEnvironment;
  projectRegistry: SystemProjectRegistry;
  workspaceRegistry: SystemWorkspaceRegistry;
  logger: Logger;
  now?: () => string;
}

export interface EnsureSystemProjectResult {
  projectId: string;
  createdProject: boolean;
  created: string[];
  adopted: string[];
  retired: string[];
}

/**
 * Daemon startup entry. A fault is logged and never stops the daemon that owns
 * running agents. Unset `enabled` means on; a daemon without an installation
 * environment is a standalone install.
 */
export async function seedSystemProjectAtStartup(
  input: Omit<EnsureSystemProjectInput, "environment"> & {
    enabled: boolean | undefined;
    sharedProviderPreferences: { installation?: { environment: "host" | "container" } } | undefined;
  },
): Promise<void> {
  if (input.enabled === false) return;
  const { enabled: _enabled, sharedProviderPreferences, ...rest } = input;
  try {
    await ensureSystemProject({
      ...rest,
      environment: sharedProviderPreferences?.installation?.environment ?? "single",
    });
  } catch (error) {
    input.logger.error({ err: error }, "Vorteo System project setup failed");
  }
}

// One daemon owns one PASEO_HOME; this only stops overlapping calls in-process
// from allocating two projects.
const inFlight = new Map<string, Promise<EnsureSystemProjectResult>>();

/**
 * Idempotent startup step: guarantees this daemon's Vorteo System project and
 * its system-managed workspaces exist. Finds the project by marker, so record
 * IDs stay random. Never deletes anything.
 */
export function ensureSystemProject(
  input: EnsureSystemProjectInput,
): Promise<EnsureSystemProjectResult> {
  const pending = inFlight.get(input.paseoHome);
  if (pending) return pending;
  const run = ensureUnlocked(input).finally(() => inFlight.delete(input.paseoHome));
  inFlight.set(input.paseoHome, run);
  return run;
}

async function ensureUnlocked(input: EnsureSystemProjectInput): Promise<EnsureSystemProjectResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const paths = systemPaths(input.paseoHome);
  const roles = rolesForEnvironment(input.environment);

  // Directories first, so reconciliation never sees a system folder missing.
  await fs.mkdir(paths.source, { recursive: true });
  for (const role of roles) await fs.mkdir(paths.runner(role.role), { recursive: true });

  const config = await readSystemProjectConfig(paths.config, input.logger);
  const { project, createdProject } = await ensureProject(input, paths.source, now);
  const result: EnsureSystemProjectResult = {
    projectId: project.projectId,
    createdProject,
    created: [],
    adopted: [],
    retired: [],
  };

  const workspaces = await input.workspaceRegistry.list();
  const members = workspaces.filter(
    (workspace) => workspace.systemMembership && workspace.projectId === project.projectId,
  );

  for (const role of roles) {
    if (members.some((member) => member.systemMembership?.role === role.role)) continue;
    const adoptId = config.adopt?.[role.role];
    const candidate = adoptId ? workspaces.find((w) => w.workspaceId === adoptId) : undefined;
    const refusal = adoptId ? adoptionRefusal(candidate) : null;
    if (adoptId && refusal) {
      input.logger.warn(
        { role: role.role, workspaceId: adoptId, reason: refusal },
        "Vorteo System did not adopt the configured workspace; creating a new one",
      );
    }
    if (candidate && !refusal) {
      await input.workspaceRegistry.writeSystemWorkspace(
        adopt(candidate, project, role, paths.runner(role.role), now()),
      );
      result.adopted.push(candidate.workspaceId);
    } else {
      const workspace = createRoleWorkspace(
        project,
        role,
        paths.runner(role.role),
        now(),
        workspaces,
      );
      await input.workspaceRegistry.writeSystemWorkspace(workspace);
      result.created.push(workspace.workspaceId);
    }
  }

  // A role that leaves the manifest keeps its workspace and history, but the owner
  // can now archive it like any other.
  const activeRoles = new Set(roles.map((role) => role.role));
  for (const member of members) {
    if (activeRoles.has(member.systemMembership!.role)) continue;
    const { systemMembership: _retired, ...retained } = member;
    await input.workspaceRegistry.writeSystemWorkspace({
      ...retained,
      standing: false,
      protected: false,
      updatedAt: now(),
    });
    result.retired.push(member.workspaceId);
  }

  if (
    result.createdProject ||
    result.created.length ||
    result.adopted.length ||
    result.retired.length
  )
    input.logger.info(result, "Vorteo System project reconciled");
  return result;
}

async function ensureProject(
  input: EnsureSystemProjectInput,
  rootPath: string,
  now: () => string,
): Promise<{ project: PersistedProjectRecord; createdProject: boolean }> {
  const projects = await input.projectRegistry.list();
  const existing = projects
    .filter((project) => project.systemProject?.kind === SYSTEM_PROJECT_KIND)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.projectId.localeCompare(right.projectId),
    );
  if (existing.length > 1) {
    input.logger.warn(
      { kept: existing[0]!.projectId, extra: existing.slice(1).map((p) => p.projectId) },
      "Found more than one Vorteo System project; keeping the oldest for an operator to review",
    );
  }
  if (existing[0]) return { project: existing[0], createdProject: false };

  const taken = new Set(projects.map((project) => project.projectId));
  let projectId = generateProjectId();
  while (taken.has(projectId)) projectId = generateProjectId();
  const timestamp = now();
  const project = {
    ...createPersistedProjectRecord({
      projectId,
      rootPath,
      kind: "non_git",
      displayName: "vorteo",
      customName: SYSTEM_PROJECT_NAME,
      // A key of its own keeps the project out of any same-remote group, even after
      // its folder becomes a clone of the Vorteo repository.
      projectKey: `system:${input.serverId}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    systemProject: { kind: SYSTEM_PROJECT_KIND },
  };
  await input.projectRegistry.writeSystemProject(project);
  return { project, createdProject: true };
}

function adoptionRefusal(candidate: PersistedWorkspaceRecord | undefined): string | null {
  if (!candidate) return "workspace not found";
  if (candidate.archivedAt) return "workspace is archived";
  if (candidate.factoryMembership) return "workspace belongs to Factory";
  if (candidate.systemMembership) return "workspace already has a system role";
  return null;
}

function adopt(
  workspace: PersistedWorkspaceRecord,
  project: PersistedProjectRecord,
  role: SystemRole,
  cwd: string,
  timestamp: string,
): PersistedWorkspaceRecord {
  // The ID stays, so threads, journal, checklist and schedules stay attached.
  // Existing threads keep their own working folder; new ones start in `cwd`.
  return {
    ...workspace,
    projectId: project.projectId,
    projectMembership: null,
    kind: "directory",
    cwd,
    displayName: role.role,
    title: role.title,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    systemMembership: { role: role.role },
    standing: true,
    protected: true,
    updatedAt: timestamp,
  };
}

function createRoleWorkspace(
  project: PersistedProjectRecord,
  role: SystemRole,
  cwd: string,
  timestamp: string,
  existing: readonly PersistedWorkspaceRecord[],
): PersistedWorkspaceRecord {
  const taken = new Set(existing.map((workspace) => workspace.workspaceId));
  let workspaceId = generateWorkspaceId();
  while (taken.has(workspaceId)) workspaceId = generateWorkspaceId();
  return {
    ...createPersistedWorkspaceRecord({
      workspaceId,
      projectId: project.projectId,
      cwd,
      kind: "directory",
      displayName: role.role,
      title: role.title,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    systemMembership: { role: role.role },
    standing: true,
    protected: true,
  };
}
