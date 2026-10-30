# One-command installation

Status: approved by the owner on October 30, 2026. In progress from `plans/environment-network-gate`.

## Goal

Anyone runs one command on a Mac or Linux machine and gets a complete Vorteo installation that works on first open. The same command wraps a legacy installation, including a container-only one from before Host environments existed, into the current architecture. After installation, every change happens in the Vorteo interface, including coordinator and Dev container upgrades. The README needs only the command.

```bash
curl -fsSL https://terranlabs.com/vorteo/install | bash
```

## Why the current setup fails new owners

- `docker/multiplex/install.sh` creates a standalone Dev container. The welcome page then says to choose Connect to Host, but no Host exists.
- The Host extension needs a hand-written plan file and an agent following `docs/host-handoff.md`. Paths, ports and roots differ per machine, and it supports only macOS.
- Dev boots before any installation exists, treats itself as standalone and seeds standalone state; the coordinator binds it later.
- A container-only installation has no upgrade path to a Host. In-app updates require a Host, and they never update the coordinator or the Dev container image.
- An installation cannot work without a Tailscale account, and the installer requires Docker even when the owner wants no Dev container.

## Decisions

| Topic               | Decision                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install address     | `https://terranlabs.com/vorteo/install`, redirecting to the latest tested release's `install.sh`                                                                        |
| Repositories        | `terran-labs/vorteo` and `terran-labs/vorton`. Earlier owners redirect.                                                                                                 |
| Installation folder | `~/vorteo`, lowercase and visible, Host-only (mode 700): `source`, `host`, `container`, `state`. The owner password is always `~/vorteo/host/owner-password`.           |
| Projects folder     | `~/dev` by default, asked at install. Dev mounts it; Dev never mounts `~/vorteo`.                                                                                       |
| Releases            | The installer and in-app updates use the latest GitHub release that passed the end-to-end install tests, never `main` directly. `VORTEO_VERSION` pins one.              |
| Dev container       | Optional. Without it, the installation is Host-only and needs no Docker. With it, Dev runs in gate mode by default.                                                     |
| Remote access       | Tailscale is recommended and optional. Without it, the interface works at `http://localhost` on the Host. The installer guides Tailscale setup and accepts an auth key. |
| Platforms           | macOS (launchd) and Linux (systemd user services).                                                                                                                      |

## Install flow

`install.sh` wraps everything in one function called on its last line, reads prompts from `/dev/tty`, and runs these steps, recording each in `~/vorteo/state/install.json` so a rerun resumes:

1. **Detect.** No installation: new install. A legacy deployment: wrap it. A current installation: point to the interface, or `--repair`.
2. **Ask** three questions, each with a flag and a default: Dev container (yes), installation name (Vorteo), Projects folder (`~/dev`). Then remote access: Tailscale, with an optional auth key, or local only. Without a terminal, print the unanswered questions in a fixed format and exit with status 3 so an agent can ask the owner and rerun with flags. `--yes` takes every default.
3. **Preflight** with an exact fix for each failure: platform, Node 24, Git, Docker when a Dev container is wanted, Tailscale when chosen.
4. **Plan.** Print what will be created and where, then ask once to proceed.
5. **Create the installation first:** fetch the release into `~/vorteo/source`, generate the installation identity and owner password, write the installation name.
6. **Create Dev**, when wanted, in gate mode with `PASEO_INSTALLATION_PENDING=1`, so it never seeds standalone state.
7. **Install the Host and coordinator** as launchd agents or systemd user services. The coordinator binds both daemons on its first synchronization; matching defaults mean no settings conflict.
8. **Finish:** open the address, print a QR code for phone access when Tailscale is on, copy the owner password to the clipboard, and install the `vorteo` command (`status`, `doctor`, `open`, `update`, `uninstall`, `repair`) into `~/.local/bin`.

## Architecture changes

- **Daemons do not guess.** A daemon with `VORTEO_INSTALLATION_CLIENT_CONFIG` or `PASEO_INSTALLATION_PENDING=1` and no binding skips standalone seeding and seeds once bound. Implemented.
- **Host-only installations.** The coordinator and the app accept an installation with one environment, the Host. A Dev container can be added later from the interface.
- **Local access.** The coordinator serves the interface on Host loopback without Tailscale; Tailscale adds the remote HTTPS origin.
- **Linux Hosts.** Host operations, restarts and installer steps gain a systemd adapter beside launchd.
- **Interface upgrades cover everything.** An approved update upgrades, in order: the coordinator, the Host daemon and interface, and the Dev container image, which is rebuilt and recreated with an automatic rollback when its health check fails. Every upgrade first takes a snapshot of coordinator state, the Host and Dev daemon homes and the deployment files, which the interface can restore.
- **Accounts first.** After the first sign-in, a screen connects provider accounts once for the whole installation.

## Legacy installations

`install.sh` finds legacy deployments by their marker files and Compose projects, including a standalone `install.sh` deployment and the earlier lab layout. Wrapping keeps Dev's identity, home, workspace and agents:

1. Generate the Host plan from the deployment and install the Host and coordinator, adopting the existing container through the existing pairing and settings migration.
2. Move Dev to gate mode with rollback.
3. Move the deployment under `~/vorteo/container`, or leave it in place and record its path when moving would interrupt running work.

Agents inside an old Dev container reach this path through the repository's `AGENTS.md`, which tells them to stop and show the owner the install command, because a container cannot install its own Host.

## Workstreams

| Workstream         | Owns                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------- |
| Installer engine   | `scripts/installer/`: plan generation, launchd and systemd adapters, gate deployment, Host-only and local plans, legacy detection and adoption. Called by the installer UX through `node scripts/installer/main.mjs <plan | apply | status> --json`. |
| Installer UX       | `install.sh`, prompts, agent mode, preflight, Tailscale guidance, resume, finish screen, the `vorteo` command                                                                                                             |
| Coordinator        | Host-only installations, local access, upgrade orchestration, snapshots and restore                                                                                                                                       |
| Releases           | Release workflow, end-to-end install tests on Linux (full) and macOS (Host-only), the `terranlabs.com` redirect                                                                                                           |
| Interface and docs | Accounts first screen, update page without a Host, `AGENTS.md` notice, README, docs consolidation, removing `docs/lab-installation.md`                                                                                    |

## Acceptance

- On a Mac or Linux machine with no Vorteo state, the command produces an installation where the welcome page signs in, every environment connects, no duplicate System project appears, Accounts & profiles shows no conflict, and, with a Dev container, Dev's direct connections to the tailnet, Host and local network fail while normal tools work through the gate.
- The same holds with no Docker (Host-only) and with no Tailscale (local only).
- A container-only legacy deployment reaches the same state with its Dev identity, home and workspace preserved.
- A later release upgrades the coordinator, Host and Dev from the interface, and a failed Dev upgrade rolls back automatically.
