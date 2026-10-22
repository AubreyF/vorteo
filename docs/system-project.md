# Vorteo System project

Every Vorteo daemon keeps one protected project named **Vorteo System**. It is where you evolve your own Vorteo installation: its root is the checkout the installation was built from, so new workspaces branch from the code that is running. It also holds the installation's standing upkeep workspaces, such as the Optimization Runner. The daemon creates it at startup, so existing installations get it with their next update and new installations get it on first start.

In the sidebar it is an ordinary project. It shows the Vorteo mark until you pick another icon, sorts and drags with your other projects, and offers new workspaces like any other. Its menu keeps **Remove project** disabled and says why, and its settings explain what it is.

## Layout

Each daemon owns its own project, because Host and Dev have separate registries. Everything lives under `$PASEO_HOME/system`:

| Path              | Purpose                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `vorteo/`         | Project root when `source.checkout` is unset. Empty until you set up Vorteo source, then a git clone. |
| `runners/<role>/` | Working folder of each system-managed workspace.                                                      |
| `system.json`     | Optional install-local settings, described below.                                                     |

On the Host, `$PASEO_HOME` is outside every guest-writable mount, as the [execution installation](execution-installation.md) rules require.

## What the daemon manages

The startup step in [`ensure-system-project.ts`](../packages/server/src/server/system-project/ensure-system-project.ts) runs after the registries load and before reconciliation. It creates the folders, finds the project by its daemon-owned marker (record IDs stay random), and creates any missing workspace from the role list in [`manifest.ts`](../packages/server/src/server/system-project/manifest.ts). Running it again changes nothing. A fault is logged and never stops the daemon.

| Role                  | Environments                 | Notes                                          |
| --------------------- | ---------------------------- | ---------------------------------------------- |
| `optimization-runner` | Host, single-daemon installs | The Host runner also covers the Dev container. |

When a role leaves the list, its workspace keeps its history and becomes an ordinary workspace you can archive. Nothing is deleted. If more than one System project exists, the daemon keeps the oldest and logs the others for review.

System-managed workspaces are always standing and protected. The registries refuse to archive, remove, move, rename or unprotect them, and refuse to rename, archive or remove the project, whichever client or tool asks. Deleting a thread in a system workspace is refused too, because archiving one already is. Pinning, labels and unread state still work.

The project keeps its own key, `system:<serverId>`, whatever checkout backs it, so it never merges into another project's group. Its root follows `source.checkout` on every start, so a renamed or newly configured checkout takes effect after a restart.

## Your own workspaces

Workspaces you create in the project are ordinary: rename, move and archive them freely. Use them to tailor your installation. A change reaches the running daemon only through the reviewed source update for your installation, which builds a new release and needs your restart approval. Never edit a running release folder.

## Set up Vorteo source

When `source.checkout` names the installation's checkout, there is nothing to set up, and the daemon refuses to clone. Otherwise the Maintenance settings card offers **Set up Vorteo source** when the host advertises `systemProjectSource`. The daemon clones the repository named in `system.json` into `vorteo/`, checks out a `local` branch at the configured ref, and adds a **Vorteo source** workspace you can branch from. It clones only from `system.json`; a request cannot name another repository. It refuses a folder that already has files and clears a failed clone so you can try again.

Point `ref` at the commit your installation was built from, so your changes apply cleanly to its next source update. On a Host, that commit is in the current release's activation record.

## Settings file

`system.json` is optional and read only by daemons that support the System project. It stays out of `config.json` because that file's schema is strict, and an older daemon would refuse to start with an unknown key after a rollback.

```json
{
  "adopt": { "optimization-runner": "wks_0123456789abcdef" },
  "source": { "checkout": "/path/to/vorteo" },
  "absorb": {
    "projects": ["prj_0123456789abcdef"],
    "workspaces": ["wks_0123456789abcdef"]
  }
}
```

- `adopt` moves an existing workspace into a role, by exact ID, the first time that role has no member. The workspace keeps its ID, threads, journal, checklist and schedules. Existing threads keep their own working folder; new threads start in the role's folder. Archived, Factory and already-assigned workspaces are refused, and a fresh workspace is created instead.
- `source.checkout` is the working checkout the installation was built from. When it is a git checkout, it becomes the project root and new workspaces are its worktrees. Otherwise `source.repository` and the optional `ref` name what source setup clones.
- `absorb` folds existing projects and workspaces into the System project, by exact ID. Every workspace of a listed project moves, archived ones too, keeping its ID, folder, threads and history. A listed project left empty is archived. Factory and system workspaces are skipped. Moved workspaces stay ordinary, and later starts find nothing left to move.

An invalid file is logged and ignored.

## Compatibility and tests

Workspace descriptors carry optional `projectSystem` and `systemMembership` fields, behind the `systemProject` and `systemProjectSource` capabilities ([compatibility rules](protocol-compatibility.md)). Older clients see an ordinary standing, protected workspace.

Test daemons start without the project so fixture counts stay exact. Server tests opt in with `systemProjectEnabled: true`. Browser specs pass `PASEO_SYSTEM_PROJECT=1` in their daemon environment. Coverage lives in [`packages/server/src/server/system-project/`](../packages/server/src/server/system-project/).

## Limitations

- Installers do not write `source.checkout` yet; operators set it in `system.json`.
- The Vorteo source clone does not follow later updates yet. After an update, move its `local` branch to the newly installed commit yourself.
- The Dev container's project has no system-managed workspace until monitoring ships its collector.
- The Optimization Runner's scripts and launchd job are still installed by hand; [the roadmap](roadmap.md) tracks shipping them in source.
