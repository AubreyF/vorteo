---
name: paseo
description: Vorteo reference for managing projects, workspaces, workspace scripts, agents, task checklists, schedules, and heartbeats; prepare implementation plans and carry approved plans into new threads.
---

Vorteo is a remote daemon that manages coding agents, terminals. Control it through MCP tools or the CLI.

In this fork, daemon commands, provider credentials and project paths belong to the container. Use the checkout's `docs/docker.md` for installation and lifecycle operations. Host Docker administration belongs to the operator; never mount the Docker socket into the agent environment.

## Delivering installation changes

For Host or Dev installation updates, read the installed `installation-maintenance` skill and inspect its client's `capabilities` before proposing a host handoff. Prepare and validate committed source, submit an update for each affected target, and return its exact owner approval link. Follow contribution receipts through installation and verify the result. The scoped client requests operations; it cannot approve them. A missing capability or concrete policy rejection requires bootstrap or repair, not broader guest credentials. Include delivery, approval and installed-behavior verification as separate checklist items when planning this work.

## Plans and thread checklists

When the user says "build a plan", "prepare a plan", or "draft a plan", produce a reviewable plan with concrete checklist items. Each item names a deliverable and how to verify it. Include dependencies, unresolved decisions, constraints, and relevant validation and delivery steps. Keep the detail proportional to the work. Planning alone does not authorize implementation.

After implementation is authorized, initialize the thread's checklist from the accepted items. For a new thread, include the accepted plan, checklist, decisions, constraints, and existing authorization in `create_agent.initialPrompt`. A handoff carries completed, pending, and blocked work with its evidence; it does not start the checklist over or request authorization already given.

Vorteo displays the checklist at the bottom of the thread and combines checklist item completion across unarchived threads in the workspace's sidebar donut. Read `get_checklist` before creating items. Prefer `update_checklist` for new persistent items: pass a `mutation` with `operation: create`, `text`, and a `description` containing completion criteria. Keep the returned IDs for updates. Its other operations update fields or status, delete an item, and reorder items. `blockedBy` contains prerequisite IDs; complete prerequisites before starting a dependent item. `owner` records an assignment without launching an agent. Use `get_checklist` with an `id` to inspect details and dependents. Native provider tasks remain visible and must be edited with their native tool; do not duplicate them in Vorteo. If Vorteo checklist tools are unavailable, use Claude's `TaskCreate`/`TaskUpdate`, Codex's `update_plan`, or another supported task tool. Plain Markdown checkboxes do not update that interface. If the tools are unavailable, retain the plan in text and state that the native checklist could not be updated.

Before starting an authorized checklist item, call `update_checklist` with operation update, its returned id, and status `in_progress`. Set `activeForm` to a short description of the current activity. Normally keep one item `in_progress` per agent; multiple active items must reflect work actually running in parallel. Leave future and proposed work pending. Update status at work transitions, not only at the end of the turn: mark completed only after the stated acceptance checks pass, then mark the next item `in_progress` before working on it. Agents may set or clear blocked status on any checklist item at their discretion. Use blocked for work that cannot proceed, describe the blocker, and return it to pending or in_progress when ready. Blocked remains incomplete and does not require a dependency. If you switch away from otherwise actionable work, return it to pending and record what remains; use `blockedBy` for actual prerequisite task IDs. An actively running build or worker may remain `in_progress` while it runs. On continuation or handoff, read the checklist and reconcile stale states with the actual work before proceeding. Use the equivalent native status updates for provider-owned tasks. Do not infer completion from a worker finishing, an agent becoming idle, or a successful tool call alone.

Use checklists for substantial multi-step work. Update the existing items as progress changes; do not append duplicate copies on each turn. Check off an item when its completion criteria hold, retain unfinished or blocked items, and explain material scope changes. Worker completion alone does not complete its parent's integration or acceptance item. Checklist updates do not grant permission to delegate, publish, deploy, or restart services.

## Projects

Manage the daemon's project registry through the CLI:

```bash
paseo project create [path]
paseo project ls
paseo project rename <project-id> <name>
paseo project rename <project-id> --reset
paseo project delete <project-id>
```

For a local daemon, `project create` defaults to the current directory and resolves relative paths on the CLI machine. With `--host` or `PASEO_HOST`, always provide a path; the target daemon interprets it on its own machine. Deleting a project archives its active workspaces and removes the project from Vorteo without deleting the project directory.

## Workspaces

**`create_workspace`** — create a workspace independently of any agent. Required: `isolation` (`local` or `worktree`). Worktree isolation supports `mode: "branch-off" | "checkout-branch" | "checkout-pr"`: use `branchName`/`baseBranch` for a new branch, `branch` for an existing branch, or `prNumber` plus optional `forge`/`projectPath` for a change request. `worktreeSlug` controls the managed path. Returns the workspace descriptor centered on `workspaceId`.

Choose `baseBranch` explicitly: `origin/main` selects the remote-tracking branch; `refs/heads/main` selects local main. Bare `main` prefers local main when it exists, otherwise origin/main. Vorteo retains the resolved ref for workspace comparisons, even after rebasing the branch or changing its PR target.

**`list_workspaces`** — list active workspaces.

**`archive_workspace`** — `{ workspaceId }`. Archives the workspace, its agents, and its terminals. Local directories remain; Vorteo removes an owned worktree only after its final active workspace reference is archived.

Never declare a code task ready to archive until all associated changes are committed, merged into the intended integration branch (`main` unless the user specified another destination), and pushed to `origin`. Verify the remote branch directly and prove it contains the task commits. A local branch, backup, deployment, open PR or pushed feature branch is not sufficient. If publication is unauthorized or blocked, report that the task is not ready to archive. An explicit archive of unfinished work preserves incomplete work; it does not establish completion.

Before archiving, inspect the target worktree's staged, unstaged and untracked changes, branch tip, and integration ancestry. Report committed, integrated, remotely published and deployed status separately. Diff counters can include committed changes against a base. Preserve commits on a named branch and any uncommitted files in a verified recovery artifact outside the removed worktree. Record recovery paths privately. Archive permission alone does not authorize publication. After archive, verify navigation returns to the empty New workspace page rather than a missing-workspace route.

**`rename_workspace`** — `{ workspaceId, name }`. Rename workspace.

## Workspace scripts

Configured `paseo.json` scripts use the same supervised lifecycle from tools and the CLI.

**`list_workspace_scripts`** — `{ workspaceId }`. Lists configured scripts with lifecycle, service port, proxy URLs, health, exit code, and terminal ID.

**`start_workspace_script`** — `{ workspaceId, scriptName }`. Starts one configured script through Vorteo's managed workspace-script launcher and returns its status metadata.

**`stop_workspace_script`** — `{ workspaceId, scriptName }`. Stops a running script through its supervised terminal and returns the stopped status metadata.

The matching CLI surface accepts either an explicit workspace ID or resolves the current directory:

```bash
paseo script ls [--cwd <path> | --workspace <workspace-id>]
paseo script start <name> [--cwd <path> | --workspace <workspace-id>]
paseo script stop <name> [--cwd <path> | --workspace <workspace-id>]
```

## Agents

**`create_agent`** — required: `title`, `provider` (`claude/opus`, `codex/gpt-5.4`, …), `initialPrompt`. Optional: `workspaceId`, `notifyOnFinish`, `settings`, `labels`. Returns `{ agentId, workspaceId, … }`.

Initial runtime settings live under `settings`: `modeId`, `thinkingOptionId`, and provider-specific `features`. Agent profiles are the preferred source for these values. For Codex fast mode, pass `settings: { features: { "fast_mode": true } }` when creating the agent.

Agent-scoped creation always creates your subagent. Omit `workspaceId` to use your current workspace; pass a workspace returned by `create_workspace` for isolated delegation. Placement never changes parentage.

Detach is an explicit user action in the subagents track, not an agent tool. A cross-workspace child remains your subagent even though it also appears as a normal tab in its workspace.

Agent-scoped `create_agent` defaults `notifyOnFinish` to true. Set it to `false` only for truly fire-and-forget agents.

**`send_agent_prompt`** — `{ agentId, prompt }`. Use for follow-ups to an existing agent. Agent-scoped prompt calls default to `background: true` and `notifyOnFinish: true`; top-level calls default to blocking with no callback. For a synchronous follow-up, pass `background: false` and use the returned result.

**`update_agent`** — `{ agentId, name?, labels?, settings? }`. Use `settings` for runtime changes on an existing agent: `modeId`, `model`, `thinkingOptionId`, and provider-specific `features`. For Codex fast mode, pass `settings: { features: { "fast_mode": true } }`.

**`list_agents`** — filter by `cwd`, `statuses`, `sinceHours`, `includeArchived`.

**`archive_agent`** — `{ agentId }`. Interrupts if running, removes from active list.

## Agent profiles and provider discovery

**`list_profiles`** — named launch bundles configured by the human. Before choosing how to launch a delegated agent, call this tool and read every profile's `notes`. Pick a named profile the user requested, or the profile whose notes best match the work.

Launch a saved preset with `create_agent.profileId` set to its `id` and `provider` set to its `provider/model` pair. The preset must have an explicit model. Copy its `modeId`, when present, into `settings.modeId` to preserve permissions. The daemon resolves the preset's model, reasoning, features, instructions and worker configuration, then freezes them for this task. Later preset edits affect new tasks.

If your launch instructions name a configured worker preset, use that exact `profileId` and provider/model pair. The daemon enforces that worker selection and concurrency limit. Do not substitute another profile or omit `profileId`; copying individual fields does not carry preset instructions or supervision settings.

Without a configured worker constraint, if no profile fits or none are configured, use the provider discovery tools below rather than guessing. Tell the user when you fall back to a direct provider launch. If the installed `create_agent` schema lacks `profileId`, a preset launch requires a host update; do not silently flatten the preset into individual fields.

**`list_providers`** — compact provider availability and modes.

**`list_models`** — full model list for one provider. Use only when you need model IDs or thinking options; the list can be large.

**`inspect_provider`** — compact provider capability and feature inspection. Required: `provider`; pass `cwd` when you are not in an agent-scoped session. Optional: `settings` with draft `model`, `modeId`, `thinkingOptionId`, and `features`.

Only set feature IDs returned by `inspect_provider`. For Codex fast mode, look for `fast_mode` and pass `settings: { features: { "fast_mode": true } }` to `create_agent` or `update_agent`.

## Schedules and heartbeats

**`create_schedule`** — starts a new agent on a cron cadence. Required: `prompt`, `cron`, `provider`. Optional: `timezone`, `name`, `cwd`, `maxRuns`, `expiresIn`. Use when the recurring work should live in fresh agents.

**`create_heartbeat`** — sends you a prompt on a cron cadence. Required: `prompt`, `cron`. Optional: `timezone`, `name`, `maxRuns`, `expiresIn`. Use for reminders, PR/build babysitting, and status checks that should return to this conversation.

**`delete_heartbeat`** stops it. MCP intentionally exposes no heartbeat update tool; delete and recreate when its task or cadence changes.

Schedules have the full list/inspect/update/pause/resume/run-once/log/delete surface. Heartbeats deliberately do not.

## Waiting

Agents take time — 10–30+ minutes is routine. Favor asynchronous workflows.

For agent-scoped `create_agent` and background `send_agent_prompt`, leave `notifyOnFinish` omitted or set it to `true` unless the work is truly fire-and-forget. You will get notified when the target agent finishes, errors, or needs permission. Move on to other work. The notification arrives on its own.

Don't poll `list_agents` or `get_agent_status` to "check on" a running agent. The notification will tell you.

## CLI semantics

The CLI and tools use the same ownership semantics even where their syntax differs:

```bash
paseo workspace create --isolation worktree --mode branch-off --new-branch fix-x --base origin/main
paseo workspace create --isolation worktree --mode checkout-branch --branch existing-work
paseo workspace create --isolation worktree --mode checkout-pr --pr-number 42
paseo run --provider codex/gpt-5.4 --mode full-access --workspace <workspace-id> "<prompt>"
paseo run --provider codex/gpt-5.4 --mode full-access --new-workspace worktree --worktree-mode branch-off --new-branch fix-x --base origin/main "<prompt>"
paseo send <agent-id> "<follow-up>"
paseo ls
paseo schedule create --cron "*/15 * * * *" "ping main build"
paseo heartbeat create --cron "*/15 * * * *" "check the build"
```

Discover with `paseo --help` and `paseo <cmd> --help`.

For product questions, setup, logs, version problems, or troubleshooting, use the **paseo-help** skill.
