import type {
  FetchWorkspacesOptions,
  FetchWorkspacesEntry,
  FetchWorkspacesPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface NewDestinationWorkspace {
  client: Pick<DaemonClient, "createWorkspace">;
  project: WorkspaceProjectDescriptorPayload;
  checkout: "directory" | "worktree";
  title: string;
  idempotencyKey: string;
}

export async function createDestinationWorkspace(input: NewDestinationWorkspace) {
  const { project } = input;
  if (input.checkout === "worktree" && project.projectKind !== "git") {
    throw new Error("Choose a Git project to create a worktree.");
  }
  const source =
    input.checkout === "worktree"
      ? {
          kind: "worktree" as const,
          projectId: project.projectId,
          cwd: project.projectRootPath,
          action: "branch-off" as const,
        }
      : { kind: "directory" as const, projectId: project.projectId, path: project.projectRootPath };
  const result = await input.client.createWorkspace({
    source,
    title: input.title.trim() || "New workspace",
    idempotencyKey: input.idempotencyKey,
  });
  if (result.error) throw new Error(result.error);
  if (!result.workspace) throw new Error("Workspace creation is incomplete. Retry to recover it.");
  return result.workspace;
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
