# Task delivery

Only the Vorteo :: Builds thread runs the publishing and installation steps below. Other threads stop when their branch is ready and hand it to Builds; see [Builds coordinator](../AGENTS.md#builds-coordinator).

Use these scripts for the checks and operations described below. The ownership and delegation rules in the [agent guide](../AGENTS.md#builds-coordinator) are operating instructions, not a claim that scripts enforce every boundary; the guide's [authorization levels](../AGENTS.md#authorization-levels) decide how far a task may go. Each script prints what it checked and refuses rather than guessing. Tests live in [`scripts/agent-lifecycle.test.mjs`](../scripts/agent-lifecycle.test.mjs) and run in CI.

## Start in a task worktree

```sh
node scripts/task-worktree.mjs <slug> [--branch fix/<slug>] [--base origin/main]
```

The script fetches with pruning, then creates `../<repo>-<slug>` on a new `feat/<slug>` branch from the fetched base, with its own dependency install. Set `PASEO_TASK_WORKTREE_ROOT` or pass `--root` to choose another parent directory. Branch names start with `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `perf/` or `test/`.

Use a dedicated task checkout for edits and reuse it for sequential work. Create separate filesystem worktrees when concurrent edits need isolation; read-only review needs none. Keep child agents in the builder's workspace. A worktree is filesystem isolation, not a new outcome or workspace.

The helper installs dependencies by default; `--no-install` skips that step but still fetches with pruning. When ref preservation or a no-pruning boundary applies, do not use the helper. Fetch with `git fetch --no-prune origin` and create the requested branch and worktree with `git worktree add -b <branch> <path> <base>`, preserving the authorized base. Do not install dependencies unless the task requires and permits it. Never edit the primary checkout, overwrite another task's changes or clean up refs as a side effect of preparation.

## Coordinate delivery

Builds owns actual build and release validation, integration, publication, installation and installation recovery. Existing feature and CI owners retain source defects and unrelated CI triage; send them exact evidence and acceptance checks. Keep only the delivery dependency in Builds' checklist, linking the upstream defect, current owner and condition for resumption. Do not expand the queue into broad implementation or a general make-CI-green project.

Use dynamically sized bounded subagents when authorized, within configured permissions, presets, budgets and actual enforced capacity. Schedule heavy builds separately with Builds; spare agent capacity does not authorize a competing build. Reuse suitable available agents, assign explicit file ownership and independent review, and keep children in the builder's existing workspace. There is no permanent lane count. Preserve the existing owner workspace when routing work; a new workspace requires a distinct outcome without an existing owner and an explicitly authorized split. Consequential scope or ownership changes need a concise owner question unless already authorized; routine execution choices do not.

Reuse verified evidence when the source and relevant inputs are unchanged. Coordinate required build and release checks, rerunning affected checks when a change or unresolved failure invalidates evidence. Batch compatible deliveries while serializing integration, publication and lifecycle operations under Builds. Keep ready independent interface delivery moving despite unrelated server CI, daemon or recovery work unless an exact applicable gate requires a hold. Record that gate and the condition that clears it. Do not bypass, disable or weaken any required check.

Report published source, served interface and installed daemon revisions separately. `main` can advance before installation, and a static interface can be published without restarting the daemon. Preserve deployed ancestry and all existing CI, restart and approval gates; these instructions add no runtime enforcement or new permission.

## Handoff contract

A handoff must identify the receiving owner and preserve that owner's workspace. Include these fields in a private handoff or task metadata, with no secrets:

| Field                       | Required content                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome and owner           | Requested result, current owner, receiving owner, existing workspace and exact file ownership.                                                                       |
| Source                      | Repository, branch, base and head commits, worktree location, exact patch and any uncommitted or untracked work.                                                     |
| Evidence                    | Checks run, results, source and input bindings, retained log or receipt locations, and what remains unverified. Identify unchanged evidence suitable for reuse.      |
| Failed attempts             | What was attempted, exact failure evidence, conclusions and exhausted approaches so the receiver does not repeat them blindly.                                       |
| Holds and authority         | Current authorization, owner decisions, approval and restart holds, cancellations, access limits and unresolved questions. A handoff grants no additional authority. |
| Acceptance and dependencies | Passed and remaining checks, upstream defect links and owners, concrete blockers, resumption conditions and the next bounded action.                                 |

The receiving owner reconciles the handoff with source and current evidence before continuing. Builds keeps a concise linked delivery dependency while the feature or CI owner retains implementation. Worker completion or transfer does not complete integration, publication, installation or unfinished acceptance.

## Shared dependency installs

`node scripts/install-dependencies.mjs` installs a checkout's dependencies. Task worktrees and the workspace setup in `paseo.json` use it, and web builds use its library with `--mode build`. On macOS it keeps one complete install per lockfile under `~/.cache/vorteo-dependencies` and clones it into each checkout with APFS copy-on-write (`cp -c`). Every checkout gets its own `node_modules` trees, so workspace links such as `node_modules/@getpaseo/server -> ../../packages/server` still resolve inside that checkout, and edits never reach another one. Clones share disk blocks until a file changes.

The cache key covers the lockfile, every workspace `package.json`, `.npmrc`, the Node and npm versions, the platform and the install mode. Worktree mode also covers the dependency patches, because its full `npm ci` applies them. A cache miss runs a normal `npm ci` and then saves the result; a failed clone falls back to `npm ci`. The cache keeps the four most recently used installs. Other platforms, and `VORTEO_DEPENDENCY_CACHE=0`, always run `npm ci`. Do not replace this with one symlinked `node_modules`: Node resolves symlinks to real paths, so every workspace import would load from one checkout.

## Publish to `main`

```sh
node scripts/publish-main.mjs [--dry-run]
```

Run it from the clean task checkout after rebasing onto `origin/main` and committing through the normal hooks. It refuses local changes, a base that moved, and a missing Gitleaks binary, which the pre-push secret scan needs. It looks in common install locations when the agent shell lacks them on `PATH`. After a fast-forward push it reads the remote branch back and fails unless it equals the published commit. Never force-push.

## Deliver to the Host

The Host updater installs only source that descends from the installed release, and it folds in published interface records. Build the update from the installed source, then merge `main`:

```sh
node scripts/prepare-host-delivery.mjs --checkout <delivery-dir> \
  --source-repo <installation source repository> --installed <installed commit>
```

Read the installed commit from the current release's activation record and the source repository from the installation's update request. Keep these paths out of Git. Each run takes one step: it resets a new checkout to the installed commit, or starts the next merge of a newer installed release, a published record, or `main`. A newer installed release that already contains the branch is reached by fast-forward. Release-note conflicts keep both sides, and manifest conflicts that differ only in Vorteo version strings keep the installed side. Resolve any other conflict yourself. Finish each merge with `npm run version:vorton`, a changelog entry and a normal commit, then run the script again until it reports ready. Publish the result to `main` and submit it with the installation client.

After any Host install whose source is not yet on `main`, publish that source to `main` the same day. A Host that runs ahead of GitHub blocks the next update from `main`.

## Archive a task

```sh
node scripts/archive-readiness.mjs [worktree] [--installed <commit>]
```

The check passes when the worktree has no uncommitted or untracked files and every commit is on `origin/main`. Commits that arrived by cherry-pick, rebase or squash count. Pass `--installed` for work that must be running on the installation. Exit status 0 means ready, 1 means blocked with the reasons listed, and 2 means the check could not run.

When the check passes and the task's completion criteria hold, end your report by offering to archive. Archive only when the owner asks. Reconcile duplicate or stale tasks, thread outputs and remaining ownership before authorized archival. The check does not grant archival permission or replace inspecting the workspace's threads and preserving unrelated work.

## Clean up worktrees

```sh
node scripts/worktree-cleanup.mjs [--apply] [--idle-hours 24]
```

Without `--apply` it only reports. It removes a worktree only when the archive check passes and its Git index has been idle for the window, then deletes the branch if all its work is on `origin/main`. It keeps locked, dirty, unpublished, recently used and protected-branch worktrees. Git itself refuses to remove a worktree with changes. A shared repository also lists worktrees from other environments, such as the Dev container; they look missing from here and stay unless you pass `--prune-missing`. Run `--apply` only for worktrees your task owns or with the owner's approval.
