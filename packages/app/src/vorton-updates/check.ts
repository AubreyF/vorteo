import { z } from "zod";

export const VORTON_REPOSITORY = "https://github.com/terran-labs/vorteo";
const API = "https://api.github.com/repos/terran-labs/vorteo";
const CommitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
const ComparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
  ahead_by: z.number().int().nonnegative(),
});

export interface VortonUpdate {
  status: "current" | "ahead" | "available" | "diverged" | "unpublished";
  latestCommit: string;
  incomingCommits: number;
}

interface GitHubResponse {
  status: number;
  body: unknown;
}

async function request(url: string, signal: AbortSignal): Promise<GitHubResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function requireSuccess(response: GitHubResponse) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      response.status === 403 || response.status === 429
        ? "GitHub limited update checks. Try again later."
        : `GitHub update check failed (${response.status}). Try again.`,
    );
  }
}

export async function checkVortonUpdate(
  currentCommit: string,
  signal: AbortSignal,
): Promise<VortonUpdate> {
  if (!/^[a-f0-9]{40}$/.test(currentCommit)) throw new Error("This build has no source commit.");
  const latestResponse = await request(`${API}/commits/main`, signal);
  requireSuccess(latestResponse);
  const { sha: latestCommit } = CommitSchema.parse(latestResponse.body);
  if (latestCommit === currentCommit) {
    return { status: "current", latestCommit, incomingCommits: 0 };
  }
  const comparisonResponse = await request(
    `${API}/compare/${currentCommit}...${latestCommit}?per_page=1`,
    signal,
  );
  if (comparisonResponse.status === 404) {
    return { status: "unpublished", latestCommit, incomingCommits: 0 };
  }
  requireSuccess(comparisonResponse);
  const comparison = ComparisonSchema.parse(comparisonResponse.body);
  const status = {
    ahead: "available",
    behind: "ahead",
    identical: "current",
    diverged: "diverged",
  } as const;
  return {
    status: status[comparison.status],
    latestCommit,
    incomingCommits: comparison.ahead_by,
  };
}

export function buildUpdatePrompt(currentCommit: string | null, latestCommit: string | null) {
  return `Help me update my Vorteo installation from ${VORTON_REPOSITORY}, branch main.
The web client’s source base is ${currentCommit ?? "an unknown commit"}. ${latestCommit ? `The update check found commit ${latestCommit}.` : "Check the latest commit on main."}

First identify the installation's actual source checkout and deployment. The selected project may be unrelated or a separate worktree: verify its remote and the serving installation before changing anything. Read AGENTS.md and docs/docker.md and docs/instance-continuity.md. Inspect the branch, local changes, and existing merge/rebase state.

Fetch main from the verified Vorteo repository. Preserve all local work. Fast-forward when possible; otherwise help merge upstream changes and resolve conflicts without dropping customizations. Ask me about genuinely ambiguous conflict resolutions. Do not reset, clean, force-push, or overwrite uncommitted work. Do not start a second merge over an unfinished one. Do not push anything remotely.

Run the required focused checks, build, and publish the updated web interface to this installation. Explain any additional daemon/container update needed. Ask for explicit approval before stopping or restarting the running instance; active agents may be interrupted. Use the installation-maintenance skill for an owner-approved restart. If host access is unavailable, provide the repository-prescribed continuity prompt. Verify the served version and commit before claiming the installation is updated. A successful Git merge alone does not update the running app.`;
}
