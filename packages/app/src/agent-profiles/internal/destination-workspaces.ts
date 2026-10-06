import type {
  FetchWorkspacesOptions,
  FetchWorkspacesEntry,
  FetchWorkspacesPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface NewDestinationWorkspace {
  client: Pick<DaemonClient, "createWorkspace" | "setWorkspaceProject">;
  project: NonNullable<WorkspaceDescriptorPayload["projectMembership"]>;
  directory: string;
  title: string;
  idempotencyKey: string;
}

export async function createDestinationWorkspace(input: NewDestinationWorkspace) {
  const result = await input.client.createWorkspace({
    source: { kind: "directory", path: input.directory },
    title: input.title.trim() || "New workspace",
    idempotencyKey: input.idempotencyKey,
  });
  if (result.error) throw new Error(result.error);
  if (!result.workspace) throw new Error("Workspace creation is incomplete. Retry to recover it.");
  await input.client.setWorkspaceProject({
    workspaceId: result.workspace.id,
    membership: input.project,
  });
  return result.workspace;
}

export async function resolveDestinationDirectory(input: {
  client: Pick<DaemonClient, "listProjects" | "browseProjectDirectories"> &
    DestinationWorkspaceClient;
  project: NonNullable<WorkspaceDescriptorPayload["projectMembership"]>;
  repositoryKey: string | null;
}) {
  const workspaces = await readDestinationWorkspaces(input.client);
  const member = workspaces.find(
    (workspace) => workspace.projectMembership?.key === input.project.key,
  );
  if (member) return member.workspaceDirectory ?? member.projectRootPath;
  const projects = (await input.client.listProjects()).projects;
  const matches = projects.filter(
    (project) => input.repositoryKey && project.projectKey === input.repositoryKey,
  );
  if (matches.length === 1) return matches[0].projectRootPath;
  const browse = await input.client.browseProjectDirectories({});
  if (browse.error) throw new Error(browse.error);
  const directory =
    browse.directory?.containerPath ??
    browse.roots.find((root) => root.id === "home")?.containerPath;
  if (!directory) throw new Error("No working directory is available in this environment.");
  return directory;
}

export interface DestinationWorkspaceClient {
  fetchWorkspaces(
    options?: Pick<FetchWorkspacesOptions, "page">,
  ): Promise<{ entries: FetchWorkspacesEntry[]; pageInfo: FetchWorkspacesPageInfo }>;
}

export async function readDestinationWorkspaces(client: DestinationWorkspaceClient) {
  const entries: WorkspaceDescriptorPayload[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({ page: { limit: 100, cursor } });
    entries.push(...page.entries.filter((item) => !item.archivingAt));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}
