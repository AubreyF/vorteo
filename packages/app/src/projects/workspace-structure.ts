import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import { isInsideProjectsRoot } from "./projects-root";

export interface WorkspaceStructureHostPlacement {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  worktreeSupport: "supported" | "unsupported" | "unknown";
  customIconRevision?: string | null;
  iconRevision?: string;
}

export interface WorkspaceStructureProject {
  viewKey: string;
  projectKey: string | null;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"] | "unknown";
  iconWorkingDir: string;
  hosts: WorkspaceStructureHostPlacement[];
  workspaceKeys: string[];
  membership?: { key: string; name: string };
}

export interface WorkspaceStructure {
  projects: WorkspaceStructureProject[];
}

interface WorkspaceStructureSession {
  serverId: string;
  /** The Projects folder this daemon advertises, from `advertisedProjectsRoot`. */
  projectsRoot?: string | null;
  projects: Iterable<ProjectDescriptor>;
  workspaces: Iterable<WorkspaceDescriptor>;
}

interface ProjectDraft {
  viewKey: string;
  projectKey: string | null;
  projectName: string;
  hasCustomName: boolean;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  hosts: Map<string, WorkspaceStructureHostPlacement>;
  membership?: { key: string; name: string };
  workspaces: Array<{ workspaceId: string; workspaceName: string; workspaceKey: string }>;
}

/** The single app boundary that turns host-local projects into grouped display projects. */
export function buildWorkspaceStructureProjects(input: {
  sessions: WorkspaceStructureSession[];
}): WorkspaceStructureProject[] {
  const sessions = input.sessions.map((session) => ({
    ...session,
    workspaces: Array.from(session.workspaces),
  }));
  const byProject = new Map<string, ProjectDraft>();
  const projectEntries: ProjectEntry[] = [];
  const keyCountsByServer = new Map<string, Map<string, number>>();
  const viewKeyByServerProjectId = new Map<string, Map<string, string>>();

  for (const session of sessions) {
    for (const project of session.projects) {
      projectEntries.push({
        serverId: session.serverId,
        projectsRoot: session.projectsRoot ?? null,
        project,
      });
      const sharedKey = project.projectKey ?? null;
      if (sharedKey) {
        const counts = getOrCreate(keyCountsByServer, session.serverId, () => new Map());
        counts.set(sharedKey, (counts.get(sharedKey) ?? 0) + 1);
      }
    }
  }

  const allocatedViewKeys = new Set(
    projectEntries.flatMap(({ project }) => (project.projectKey ? [project.projectKey] : [])),
  );
  const sharedFolderKeys = mergeSharedFolderProjectKeys(projectEntries, keyCountsByServer);

  for (const { serverId, project } of projectEntries) {
    const viewKey = addProjectToView({
      byProject,
      keyCountsByServer,
      allocatedViewKeys,
      sharedFolderKeys,
      serverId,
      project,
    });
    getOrCreate(viewKeyByServerProjectId, serverId, () => new Map()).set(
      project.projectId,
      viewKey,
    );
  }

  const workspaceKeys = new Set(
    sessions.flatMap((session) =>
      Array.from(session.workspaces)
        .filter((workspace) => !workspace.projectMembership?.environmentOwner)
        .map((workspace) => `${session.serverId}:${workspace.id}`),
    ),
  );
  const memberPlacements = new Map<
    string,
    Map<string, Map<string, WorkspaceStructureHostPlacement>>
  >();
  for (const session of sessions) {
    for (const workspace of session.workspaces) {
      const owner = workspace.projectMembership?.environmentOwner;
      if (owner && workspaceKeys.has(`${owner.serverId}:${owner.workspaceId}`)) continue;
      const membership = workspace.projectMembership;
      const membershipKey = sharedMembershipKey(sharedFolderKeys, membership);
      const viewKey =
        membershipKey ?? viewKeyByServerProjectId.get(session.serverId)?.get(workspace.projectId);
      if (!viewKey) continue;
      if (membership && !byProject.has(viewKey)) {
        byProject.set(viewKey, {
          viewKey,
          projectKey: null,
          projectName: membership.name,
          hasCustomName: true,
          projectKind: workspace.projectKind,
          iconWorkingDir: "",
          hosts: new Map(),
          workspaces: [],
        });
      }
      const draft = byProject.get(viewKey);
      collectMemberPlacement({
        byProject,
        viewKeyByServerProjectId,
        memberPlacements,
        viewKey,
        serverId: session.serverId,
        workspace,
      });
      draft?.workspaces.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceKey: `${session.serverId}:${workspace.id}`,
      });
    }
  }

  attachMemberPlacements(byProject, memberPlacements);

  return Array.from(byProject.values())
    .map((draft) => ({
      viewKey: draft.viewKey,
      projectKey: draft.projectKey,
      projectName: draft.projectName,
      projectKind: draft.projectKind,
      iconWorkingDir: draft.iconWorkingDir,
      hosts: Array.from(draft.hosts.values()),
      membership: draft.membership,
      workspaceKeys: draft.workspaces
        .sort(compareWorkspaceStructureItems)
        .map((workspace) => workspace.workspaceKey),
    }))
    .sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName, undefined, {
          numeric: true,
          sensitivity: "base",
        }) || left.viewKey.localeCompare(right.viewKey),
    );
}

interface MemberPlacementInput {
  byProject: Map<string, ProjectDraft>;
  viewKeyByServerProjectId: Map<string, Map<string, string>>;
  memberPlacements: Map<string, Map<string, Map<string, WorkspaceStructureHostPlacement>>>;
  viewKey: string;
  serverId: string;
  workspace: WorkspaceDescriptor;
}

function collectMemberPlacement(input: MemberPlacementInput) {
  const { byProject, viewKeyByServerProjectId, memberPlacements, viewKey, serverId, workspace } =
    input;
  const draft = byProject.get(viewKey);
  const membership = workspace.projectMembership;
  if (!membership || !draft) return;
  draft.membership = { key: viewKey, name: membership.name };
  const nativeKey = viewKeyByServerProjectId.get(serverId)?.get(workspace.projectId);
  const placement = nativeKey ? byProject.get(nativeKey)?.hosts.get(serverId) : undefined;
  if (!placement) return;
  const hosts = getOrCreate(memberPlacements, viewKey, () => new Map());
  const placements = getOrCreate(hosts, serverId, () => new Map());
  placements.set(placement.projectId, placement);
}

function attachMemberPlacements(
  byProject: Map<string, ProjectDraft>,
  memberPlacements: MemberPlacementInput["memberPlacements"],
) {
  // Logical membership does not erase native execution placement. Infer only an
  // unambiguous, hydrated placement; never choose between same-host checkouts.
  for (const [viewKey, hosts] of memberPlacements) {
    const draft = byProject.get(viewKey)!;
    for (const [serverId, placements] of hosts) {
      if (draft.hosts.has(serverId) || placements.size !== 1) continue;
      const placement = placements.values().next().value!;
      draft.hosts.set(serverId, placement);
      if (!draft.iconWorkingDir) draft.iconWorkingDir = placement.iconWorkingDir;
    }
  }
}

export function createProjectViewKey(
  identity:
    | { kind: "equivalence"; projectKey: string }
    | { kind: "placement"; serverId: string; projectId: string },
): string {
  return identity.kind === "equivalence"
    ? identity.projectKey
    : JSON.stringify([identity.serverId, identity.projectId]);
}

function allocatePlacementViewKey(
  allocatedViewKeys: Set<string>,
  serverId: string,
  projectId: string,
): string {
  const legacyKey = createProjectViewKey({ kind: "placement", serverId, projectId });
  if (!allocatedViewKeys.has(legacyKey)) {
    allocatedViewKeys.add(legacyKey);
    return legacyKey;
  }

  for (let suffix = 0; ; suffix += 1) {
    const collisionKey = JSON.stringify(["placement", serverId, projectId, suffix]);
    if (allocatedViewKeys.has(collisionKey)) continue;
    allocatedViewKeys.add(collisionKey);
    return collisionKey;
  }
}

interface ProjectEntry {
  serverId: string;
  projectsRoot: string | null;
  project: ProjectDescriptor;
}

/**
 * Remote-less projects carry a per-daemon key, so identical folders never join by key. When
 * daemons advertise the same Projects folder, a project root inside it is the same folder on
 * each, so placements at the identical root join under the smallest of their keys. Returns
 * each joined key's shared view key; persisted project keys stay unchanged.
 */
function mergeSharedFolderProjectKeys(
  entries: readonly ProjectEntry[],
  keyCountsByServer: Map<string, Map<string, number>>,
): Map<string, string> {
  const groups = new Map<string, Map<string, string>>();
  for (const { serverId, projectsRoot, project } of entries) {
    const key = project.projectKey;
    if (!key || !projectsRoot || key.startsWith("remote:")) continue;
    if (keyCountsByServer.get(serverId)?.get(key) !== 1) continue;
    const rootPath = project.projectRootPath.replace(/\/+$/u, "");
    if (!isInsideProjectsRoot(rootPath, projectsRoot)) continue;
    const group = getOrCreate(groups, JSON.stringify([projectsRoot, rootPath]), () => new Map());
    group.set(serverId, key);
  }
  const sharedKeys = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    const keys = [...new Set(group.values())].sort();
    for (const key of keys) sharedKeys.set(key, keys[0]!);
  }
  return sharedKeys;
}

function sharedMembershipKey(
  sharedFolderKeys: Map<string, string>,
  membership: WorkspaceDescriptor["projectMembership"],
): string | undefined {
  if (!membership) return undefined;
  return sharedFolderKeys.get(membership.key) ?? membership.key;
}

function addProjectToView(input: {
  byProject: Map<string, ProjectDraft>;
  keyCountsByServer: Map<string, Map<string, number>>;
  allocatedViewKeys: Set<string>;
  sharedFolderKeys: Map<string, string>;
  serverId: string;
  project: ProjectDescriptor;
}): string {
  const { byProject, keyCountsByServer, serverId, project } = input;
  const ownKey = project.projectKey ?? null;
  const canUseSharedKey = ownKey !== null && keyCountsByServer.get(serverId)?.get(ownKey) === 1;
  const sharedKey = ownKey === null ? null : (input.sharedFolderKeys.get(ownKey) ?? ownKey);
  const viewKey =
    canUseSharedKey && sharedKey !== null
      ? createProjectViewKey({ kind: "equivalence", projectKey: sharedKey })
      : allocatePlacementViewKey(input.allocatedViewKeys, serverId, project.projectId);
  const placement: WorkspaceStructureHostPlacement = {
    serverId,
    projectId: project.projectId,
    iconWorkingDir: project.projectRootPath,
    worktreeSupport: project.projectKind === "git" ? "supported" : "unsupported",
    customIconRevision: project.projectCustomIconRevision,
    iconRevision: project.projectIconRevision,
  };
  const draft = byProject.get(viewKey);
  if (!draft) {
    byProject.set(viewKey, {
      viewKey,
      projectKey: sharedKey,
      projectName:
        project.projectCustomName ??
        project.projectDisplayName ??
        projectDisplayNameFromProjectId(project.projectId),
      hasCustomName: Boolean(project.projectCustomName),
      projectKind: project.projectKind,
      iconWorkingDir: project.projectRootPath,
      hosts: new Map([[serverId, placement]]),
      workspaces: [],
    });
  } else {
    if (project.projectCustomName && !draft.hasCustomName) {
      draft.projectName = project.projectCustomName;
      draft.hasCustomName = true;
    }
    draft.hosts.set(serverId, placement);
  }
  return viewKey;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function compareWorkspaceStructureItems(
  left: { workspaceId: string; workspaceName: string },
  right: { workspaceId: string; workspaceName: string },
): number {
  return (
    left.workspaceName.localeCompare(right.workspaceName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || left.workspaceId.localeCompare(right.workspaceId, undefined, { sensitivity: "base" })
  );
}
