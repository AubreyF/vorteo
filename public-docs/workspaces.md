---
title: Workspaces
description: Understand how Vorteo groups working directories, agents, terminals, and browsers into workspaces.
nav: Workspaces
order: 10
category: Workspaces
---

# Workspaces

Vorteo is organized around workspaces, not chats.

A workspace is the place where a task happens. It has a working directory and can contain multiple sessions running at the same time. In the app, each session opens as a tab.

## Projects contain workspaces

The sidebar starts with projects. A project can be a git repository, a GitHub project, or any directory on a machine running the Vorteo daemon.

Inside each project are workspaces. For example:

```
my-app
├── main
├── fix-login-flow
└── redesign-settings
```

Each workspace is a separate place to work. You can keep one for your main checkout, create another for a feature, or open a GitHub PR as another workspace.

Use the [CLI project commands](/docs/cli#projects) to register, list, rename, or delete projects.

## Workspaces contain sessions

Agents run inside a workspace as sessions. A workspace can have one agent session, several agent sessions, terminals, browsers, and diffs open at the same time.

That matters because real development rarely fits into one long chat. You might ask one agent to implement a feature, open a terminal to run a service, start another agent to review the diff, and keep the browser open next to both. Those belong together because they are all part of the same task.

In Vorteo, the workspace is the stable container. The sessions are what you run inside it.

## Standing, Protected, and Scheduled

Open a workspace's menu and choose **Standing** for ongoing responsibilities such as a supervisor or recurring council updates. Standing workspaces appear in a collapsible section within their project. Individually pinned workspaces remain in Pinned.

Choosing Standing also enables **Protected**. A shield identifies protected workspaces. Protection blocks archiving the workspace or its agent sessions, including through bulk actions and daemon requests. Remove Protected explicitly before archiving. Turning off Standing keeps protection enabled. You can also protect an ordinary workspace.

**Scheduled** appears automatically when a schedule targets an agent in that workspace. Paused schedules keep the badge; completed or expired schedules do not. Select the badge to open Schedules. Schedules that create a fresh workspace for each run do not mark those outputs as ongoing work.

Standing and Protected require an updated daemon.

## Choose the isolation

Every workspace has an isolation mode:

- **Local** uses an existing directory, such as your main checkout. Use it when sessions should share the files already on disk.
- **Worktree** creates or opens a managed git worktree. Use it when a task needs its own directory and branch.

The workspace is the product concept; a git worktree is one way to isolate its files. More than one workspace can refer to the same managed worktree, and Vorteo removes that worktree after its last workspace is archived.

## Creating a workspace

You can create a workspace in the app or from the CLI:

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title main
paseo workspace create --isolation worktree --path ~/dev/my-app --base origin/main
```

You can also create a workspace without starting an agent right away. The workspace is still there with its working directory ready; you can open terminals, run services, or browse files, then start an agent later.

Either way, once the workspace exists you can add more sessions to it. Open a terminal alongside an agent, start a second agent to review changes, or open a browser tab to check a local service. Every session lives as a tab inside the same workspace.

Creating an agent and creating a workspace are separate actions. Pass a workspace ID when you want an agent in a specific existing workspace. A bare `paseo run` from a human shell creates a new local workspace; when one agent runs it, Vorteo recognizes the caller and creates a subagent in the caller's workspace.

## Worktrees

Every workspace in Vorteo is backed by a working directory. When that directory is a git worktree, you get a separate branch and isolated environment for each task.

If you want the details on configuring setup hooks, scripts, and services, continue to [Git worktrees](/docs/worktrees).
