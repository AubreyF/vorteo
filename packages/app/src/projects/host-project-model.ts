import type { WorkspaceDescriptor } from "@/stores/session-store";
import type {
  WorkspaceStructureHostPlacement,
  WorkspaceStructureProject,
} from "@/projects/workspace-structure";
import { createProjectViewKey } from "@/projects/workspace-structure";

export type HostProjectListItem = WorkspaceStructureProject;

export interface HostProjectRouteContext {
  serverId: string;
  projectId?: string;
  displayName?: string;
  sourceDirectory?: string;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export function canCreateWorktreeForProjectKind(
  projectKind: WorkspaceDescriptor["projectKind"],
): boolean {
  return projectKind === "git";
}

export function hostProjectFromRoute(route: HostProjectRouteContext): HostProjectListItem | null {
  const projectId = route.projectId?.trim() || undefined;
  const iconWorkingDir = trimOptional(route.sourceDirectory);
  if (!projectId || !iconWorkingDir) {
    return null;
  }
  return {
    viewKey: createProjectViewKey({ kind: "placement", serverId: route.serverId, projectId }),
    projectKey: null,
    projectName: trimOptional(route.displayName) || projectId,
    projectKind: "unknown",
    iconWorkingDir,
    hosts: [
      {
        serverId: route.serverId,
        projectId,
        iconWorkingDir,
        worktreeSupport: "unknown",
      },
    ],
    workspaceKeys: [],
  };
}

export function hostProjectFromWorkspace(input: {
  serverId: string;
  workspace: WorkspaceDescriptor | null;
}): HostProjectListItem | null {
  if (!input.workspace) {
    return null;
  }
  const projectId = input.workspace.projectId.trim() || undefined;
  if (!projectId) {
    return null;
  }
  const iconWorkingDir = input.workspace.projectRootPath.trim();
  if (!iconWorkingDir) {
    return null;
  }
  const canCreate = canCreateWorktreeForProjectKind(input.workspace.projectKind);
  return {
    viewKey:
      input.workspace.projectMembership?.key ??
      createProjectViewKey({
        kind: "placement",
        serverId: input.serverId,
        projectId,
      }),
    ...(input.workspace.projectMembership
      ? {
          membership: {
            key: input.workspace.projectMembership.key,
            name: input.workspace.projectMembership.name,
          },
        }
      : {}),
    projectKey: input.workspace.project?.projectKey ?? null,
    projectName:
      input.workspace.projectMembership?.name ?? (input.workspace.projectDisplayName || projectId),
    projectKind: input.workspace.projectKind,
    iconWorkingDir,
    hosts: [
      {
        serverId: input.serverId,
        projectId: input.workspace.projectId,
        iconWorkingDir,
        worktreeSupport: canCreate ? "supported" : "unsupported",
        customIconRevision: input.workspace.projectCustomIconRevision,
      },
    ],
    workspaceKeys: [`${input.serverId}:${input.workspace.id}`],
  };
}

function projectCanCreateWorktree(project: HostProjectListItem): boolean {
  return project.hosts.some((host) => host.worktreeSupport !== "unsupported");
}

function getHostProjectPlacement(
  project: HostProjectListItem,
  serverId: string,
): WorkspaceStructureHostPlacement | null {
  for (const host of project.hosts) {
    if (host.serverId === serverId) return host;
  }
  return null;
}

export function getWorktreeSupportForHostProject(input: {
  project: HostProjectListItem;
  serverId: string;
}): WorkspaceStructureHostPlacement["worktreeSupport"] {
  return getHostProjectPlacement(input.project, input.serverId)?.worktreeSupport ?? "unknown";
}

export function getHostProjectSourceDirectory(
  project: HostProjectListItem,
  serverId: string,
): string | null {
  return getHostProjectPlacement(project, serverId)?.iconWorkingDir ?? null;
}

export function getHostProjectId(project: HostProjectListItem, serverId: string): string | null {
  return getHostProjectPlacement(project, serverId)?.projectId ?? null;
}

export function canCreateWorkspaceForHostProject(input: {
  project: HostProjectListItem;
  serverId: string;
  allowAllProjects: boolean;
}): boolean {
  const host = getHostProjectPlacement(input.project, input.serverId);
  if (!host) {
    return false;
  }
  return input.allowAllProjects || host.worktreeSupport !== "unsupported";
}

export function filterWorkspaceProjectsForHost(input: {
  projects: readonly HostProjectListItem[];
  serverId: string;
  allowAllProjects: boolean;
}): HostProjectListItem[] {
  return input.projects.filter((project) =>
    canCreateWorkspaceForHostProject({
      project,
      serverId: input.serverId,
      allowAllProjects: input.allowAllProjects,
    }),
  );
}

function compareHostProjectsForServer(
  left: HostProjectListItem,
  right: HostProjectListItem,
  serverId: string,
): number {
  return (
    left.projectName.localeCompare(right.projectName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    (getHostProjectId(left, serverId) ?? "").localeCompare(
      getHostProjectId(right, serverId) ?? "",
    ) ||
    left.viewKey.localeCompare(right.viewKey)
  );
}

/**
 * A group whose workspaces on this host live in several local projects has no host placement
 * of its own. Borrow the placement of the workspace or sidebar row that named the group, so the
 * group stays selectable here instead of the picker falling back to an unrelated project.
 */
function withCandidatePlacement(
  group: HostProjectListItem,
  candidate: HostProjectListItem,
  serverId: string,
): HostProjectListItem {
  if (getHostProjectPlacement(group, serverId)) return group;
  const placement = getHostProjectPlacement(candidate, serverId);
  if (!placement) return group;
  // Selection state compares projects by identity; a fresh copy on every resolve never settles.
  const cached = borrowedPlacements.get(group) ?? new Map<string, HostProjectListItem>();
  borrowedPlacements.set(group, cached);
  const key = JSON.stringify([serverId, placement.projectId, placement.iconWorkingDir]);
  const existing = cached.get(key);
  if (existing) return existing;
  const borrowed = { ...group, hosts: [...group.hosts, placement] };
  cached.set(key, borrowed);
  return borrowed;
}

const borrowedPlacements = new WeakMap<HostProjectListItem, Map<string, HostProjectListItem>>();

export function resolveExactHostProjectCandidate(input: {
  candidate: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem | null {
  const exactView = input.projects.find((project) => project.viewKey === input.candidate.viewKey);
  if (exactView && exactView.projectKey === input.candidate.projectKey) {
    return withCandidatePlacement(exactView, input.candidate, input.serverId);
  }
  // Logical project identity wins over a shared native execution directory.
  // Multiple memberships can deliberately use the same host-local project.
  if (input.candidate.membership) {
    const group = input.projects.find(
      (project) => project.membership?.key === input.candidate.membership?.key,
    );
    return group ? withCandidatePlacement(group, input.candidate, input.serverId) : null;
  }
  const candidatePlacement = getHostProjectId(input.candidate, input.serverId);
  if (candidatePlacement) {
    const exactPlacement = input.projects.find(
      (project) =>
        !project.membership && getHostProjectId(project, input.serverId) === candidatePlacement,
    );
    if (exactPlacement) return exactPlacement;
  }

  return null;
}

/**
 * The project a New workspace route names. A sidebar row passes its own view key, which is the
 * row the owner clicked; matching only the routed host placement can land on another row that
 * shares the same local project.
 */
export function resolveRoutedHostProject(input: {
  projectViewKey?: string;
  placement: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem | null {
  const viewKey = input.projectViewKey?.trim();
  const row = viewKey ? input.projects.find((project) => project.viewKey === viewKey) : undefined;
  if (row) {
    return input.placement ? withCandidatePlacement(row, input.placement, input.serverId) : row;
  }
  if (!input.placement) return null;
  return (
    resolveHostProjectCandidate({
      candidate: input.placement,
      projects: input.projects,
      serverId: input.serverId,
    }) ?? input.placement
  );
}

export function resolveEquivalentHostProjectCandidate(input: {
  candidate: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem | null {
  if (input.candidate.projectKey === null) return null;
  const equivalents = input.projects.filter(
    (project) => project.projectKey === input.candidate.projectKey,
  );
  if (equivalents.length === 0) return null;
  return equivalents.sort((left, right) =>
    compareHostProjectsForServer(left, right, input.serverId),
  )[0]!;
}

export function resolveHostProjectCandidate(input: {
  candidate: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem | null {
  return resolveExactHostProjectCandidate(input) ?? resolveEquivalentHostProjectCandidate(input);
}

/**
 * The project New workspace starts with: the routed project, then the one the owner came from,
 * then their last manual choice, then the only project when there is just one. Otherwise it
 * returns null so the picker asks, rather than choosing whichever project happens to sort first.
 */
export function resolveInitialWorkspaceProject(input: {
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
  lastManualProjectViewKey?: string | null;
  projects: readonly HostProjectListItem[];
  serverId: string;
  allowAllProjects: boolean;
}): HostProjectListItem | null {
  const lastManual = input.lastManualProjectViewKey
    ? (input.projects.find((project) => project.viewKey === input.lastManualProjectViewKey) ?? null)
    : null;
  const candidates = [input.routeProject, input.lastActiveProject, lastManual];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const hydratedProject =
      resolveHostProjectCandidate({
        candidate,
        projects: input.projects,
        serverId: input.serverId,
      }) ?? candidate;
    if (
      canCreateWorkspaceForHostProject({
        project: hydratedProject,
        serverId: input.serverId,
        allowAllProjects: input.allowAllProjects,
      })
    ) {
      return hydratedProject;
    }
  }

  // With a single usable project there is nothing to ask.
  const [only, ...others] = input.projects;
  return only &&
    others.length === 0 &&
    canCreateWorkspaceForHostProject({
      project: only,
      serverId: input.serverId,
      allowAllProjects: input.allowAllProjects,
    })
    ? only
    : null;
}

export function resolveInitialWorktreeProject(input: {
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
}): HostProjectListItem | null {
  if (input.routeProject && projectCanCreateWorktree(input.routeProject)) {
    return input.routeProject;
  }
  if (input.lastActiveProject && projectCanCreateWorktree(input.lastActiveProject)) {
    return input.lastActiveProject;
  }
  return input.projects.find((project) => projectCanCreateWorktree(project)) ?? null;
}

export function resolveSelectedHostProject(input: {
  selectedViewKey: string | null;
  projects: readonly HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
}): HostProjectListItem | null {
  const selectedViewKey = input.selectedViewKey?.trim() ?? "";
  if (!selectedViewKey) {
    return null;
  }

  return (
    input.projects.find((project) => project.viewKey === selectedViewKey) ??
    (input.routeProject?.viewKey === selectedViewKey ? input.routeProject : null) ??
    (input.lastActiveProject?.viewKey === selectedViewKey ? input.lastActiveProject : null)
  );
}
