import { z } from "zod";
import record from "./upstream-sync.json";

const UpstreamSyncSchema = z.object({
  upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
  mergeCommit: z.string().regex(/^[a-f0-9]{40}$/),
  mergedAt: z.string().datetime({ offset: true }),
});

export type UpstreamSync = z.infer<typeof UpstreamSyncSchema>;
export const UPSTREAM_SYNC: unknown = record;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function upstreamSyncStatus(value: unknown, now: number) {
  const parsed = UpstreamSyncSchema.safeParse(value);
  if (!parsed.success) return { status: "unknown" } as const;
  const age = now - Date.parse(parsed.data.mergedAt);
  if (age < 0) return { status: "unknown" } as const;
  const status = age > WEEK_MS ? "overdue" : "recent";
  return { status, record: parsed.data } as const;
}

export const UPSTREAM_UPDATE_PROMPT = `Perform the weekly upstream synchronization for my Vorteo installation.

Objective
Integrate the latest upstream Paseo main into my Vorteo fork, preserve Vorteo functionality, validate and publish the result, and prepare the installed application update.

Expected fork: https://github.com/terran-labs/vorteo.git
Older checkouts may name github.com/AubreyF/paseo, AubreyF/vorteo or vortelligence/vorteo; GitHub redirects those here. Set origin to the expected fork before fetching.
Expected upstream: https://github.com/getpaseo/paseo.git
Find and verify this installation's actual source checkout and deployment on the host. Do not assume the current directory is the correct repository.

Authorization
You may fetch, configure a missing upstream remote, resolve routine conflicts, edit code and tests, commit, integrate into main, and push main normally to origin. Do not force-push or rewrite published history. Prefer the existing checkout when safe; use an isolated integration worktree only when needed to preserve active work.
You may build and validate the deployment and publish a compatible web update through the installation's documented guarded process. Restarting the main daemon or replacing its container requires explicit approval after the exact deployment and rollback plan is prepared.

Discovery and preservation
Read AGENTS.md and the relevant development, testing, release, publication-hygiene, Docker, instance-continuity, and host-handoff documentation. Gather current Git, workspace, CI, and installation evidence yourself. Preserve unrelated staged, unstaged, and untracked work. Do not stash, reset, clean, or commit someone else's changes. Check for an existing synchronization task and reuse its work instead of duplicating it. Keep private backups, deployment details, and acceptance receipts outside Git.

Select and inspect upstream
Verify the remotes and fetch both repositories. Resolve upstream's current default branch and record the exact target SHA. Compare it against the current published fork main using Git ancestry. If already incorporated, do not create an empty merge or refresh the last-merge date; separately check whether the installation matches the published fork.
Otherwise summarize incoming changes, upstream CI status, migrations, compatibility risks, and overlap with Vorteo modifications. Investigate failing upstream CI before integrating affected behavior.

Integrate
Merge the selected upstream commit into the latest fork main, preserving upstream ancestry. Do not squash upstream history, rebase published fork history, or use blanket ours/theirs conflict resolution. Preserve Vorteo features, branding, account and profile workflows, container isolation, private networking, persistence, versioning hooks, and client/daemon compatibility. Resolve straightforward adaptations yourself. Ask only when a conflict requires a substantive product decision or would remove existing behavior.

Validate and publish source
Follow repository formatting, lint, typecheck, focused regression test, and build requirements. Rebuild generated declarations when required. Inspect the final merge diff for accidentally dropped fork behavior. Use CI for broad coverage; do not run prohibited full suites locally. Update user-facing documentation when behavior changes and follow versioning and publication-hygiene rules.
After creating the successful upstream merge, update packages/app/src/vorton-updates/upstream-sync.json in a follow-up commit. Record upstreamCommit as the full selected upstream SHA, mergeCommit as the full actual merge SHA, and mergedAt as that merge's Git committer timestamp in ISO 8601 format. Verify both commits are ancestors of the delivery branch. Do not use the check time, build time, deployment time, or an unrelated fork merge. This source provenance record contains no private installation details.
Fetch origin again before integration and account for concurrent main changes. Validate any resulting changes, push without force, and verify directly that origin/main contains the selected upstream commit, the integration, and the updated sync record. Verify applicable CI results.

Update the installation
Inspect the actual running instance, image, persistent mounts, served web release, and source provenance. Use the documented existing-instance update process, not a fresh installation or a stock upstream image. Build from the validated fork revision. Preserve recovery artifacts, state, credentials, network identity, and the previous image and web release. Determine whether migrations affect rollback.
Serialize web publication with other publishers and publish only when compatible with the running daemon. If a restart or container replacement is needed, finish build, validation, backup preparation, and rollback planning before asking for that specific approval. Do not interrupt running agents without it.
Verify the rendered application through its existing private HTTPS URL, release provenance, WebSocket connection, and relevant Vorteo workflows. Confirm Settings > General shows the new upstream merge date. Mark account or physical-device checks untested unless actually verified.

Completion
Report the upstream target and important changes, fork integration, directly verified remote publication, validation and CI results, actual web and daemon deployment revisions, and anything pending. Record a concise private sync receipt. If blocked, preserve completed work and identify the exact next action. Never claim the installation is synchronized merely because Git was updated.`;
