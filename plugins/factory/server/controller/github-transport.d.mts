/** Caller validates decoded GitHub JSON before using it as authority. */
export function decodeGitHubResponse(bytes: Uint8Array, paginate?: boolean): unknown;

export type GitHubMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** No transport retry: failed writes require durable-intent reconciliation. */
export function githubRequest(
  method: GitHubMethod,
  endpoint: string,
  body?: unknown,
  paginate?: boolean,
): Promise<unknown>;
export function githubJobLog(repository: string, jobId: number): Promise<Buffer>;
export function githubArtifactArchive(repository: string, artifactId: number): Promise<Buffer>;
