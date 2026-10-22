# Task delivery

Only the Vorteo :: Builds thread runs the publishing and installation steps below. Other threads stop when their branch is ready and hand it to Builds; see [Builds coordinator](../AGENTS.md#builds-coordinator).

Use these scripts to move a task from a fresh worktree to `main`, the installation and archive. They enforce rules from the [agent guide](../AGENTS.md); the guide's [authorization levels](../AGENTS.md#authorization-levels) decide how far a task may go. Each script prints what it checked and refuses rather than guessing. Tests live in [`scripts/agent-lifecycle.test.mjs`](../scripts/agent-lifecycle.test.mjs) and run in CI.

## Start in a task worktree

```sh
node scripts/task-worktree.mjs <slug> [--branch fix/<slug>] [--base origin/main]
```

The script fetches, then creates `../<repo>-<slug>` on a new `feat/<slug>` branch from the fetched base, with its own `npm ci` install. Set `PASEO_TASK_WORKTREE_ROOT` or pass `--root` to choose another parent directory. Branch names start with `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `perf/` or `test/`.

Use it for Level 2 and higher work unless you already run in a clean, dedicated worktree at the fetched base. Never edit a shared checkout that holds another task's changes, and never discard those changes to make room.

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

When the check passes and the task's completion criteria hold, end your report by offering to archive. Archive only when the owner asks. The check does not replace inspecting the workspace's threads and preserving unrelated work.

## Clean up worktrees

```sh
node scripts/worktree-cleanup.mjs [--apply] [--idle-hours 24]
```

Without `--apply` it only reports. It removes a worktree only when the archive check passes and its Git index has been idle for the window, then deletes the branch if all its work is on `origin/main`. It keeps locked, dirty, unpublished, recently used and protected-branch worktrees. Git itself refuses to remove a worktree with changes. A shared repository also lists worktrees from other environments, such as the Dev container; they look missing from here and stay unless you pass `--prune-missing`. Run `--apply` only for worktrees your task owns or with the owner's approval.
