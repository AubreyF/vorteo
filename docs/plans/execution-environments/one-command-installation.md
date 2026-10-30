# One-command installation

Status: approved by the owner on October 30, 2026. In progress on `plans/environment-network-gate`.

## Goal

One command on a Mac creates a complete Vorteo installation that works on first open: the installation coordinator, the Host environment, the Dev container behind the [network gate](network-gate.md), and one address and password location. Legacy installations, including container-only ones created before Host environments existed, reach the same architecture through their normal update path. The Host manages the installation in every case.

## Why the current setup fails new owners

- `docker/multiplex/install.sh` creates a standalone Dev container. The welcome page then says to choose Connect to Host, but no Host exists.
- The Host extension needs a hand-written plan file and an agent following `docs/host-handoff.md`. Paths, ports and roots differ per machine.
- Dev boots before any installation exists, treats itself as a standalone install and seeds standalone state. The coordinator binds it later, so every new installation passes through a transition: a retired Optimizer, a shared-settings migration and an account check that could not complete.
- A container-only installation has no upgrade path to a Host. In-app updates require a Host; container agents cannot install Host software.

## Design

### The installation exists before any environment boots

`scripts/install.sh` (new) runs on the Host and orders setup so no environment ever runs unbound:

1. Check prerequisites: macOS, Docker, Tailscale running, Node 24 (installed through the existing Node detection or reported with the exact fix).
2. Create the standard layout under `~/.local/share/vorteo` (mode 700): `source` (this checkout), `container` (Dev deployment), `host` (installation root), `private` (generated installer inputs). The Projects folder is `~/Vorteo`.
3. Generate the installation identity: installation ID, Dev server ID and the Dev pairing credentials, before Dev exists.
4. Create Dev in gate mode with its server ID and installation client file already in its home, so its first boot is as the installation's container. Dev waits for its binding rather than seeding standalone state.
5. Install the Host extension from the generated plan. The coordinator binds both daemons on its first synchronization. Fresh daemons with matching defaults produce no settings conflict.
6. Print the address and the owner password file, and offer the copy command.

`install.sh` is idempotent per step and refuses to overwrite an existing installation. `--standalone` keeps the container-only product for owners who want it.

### Daemons do not guess

A daemon started with `VORTEO_INSTALLATION_CLIENT_CONFIG` but no installation binding is installation-managed and not yet bound. It skips standalone seeding, such as the Vorteo System runner, and seeds once the binding arrives. Only a daemon with neither is standalone.

### Defaults match across environments

Every shared setting starts with the same value in Host and Dev, so the coordinator's first synchronization commits revision 1 without a migration screen. A fresh installation never shows "choose the initial shared configuration". The migration remains for adopting existing installations.

### Accounts connect once

Setup providers and every account entry point open the installation's Accounts page. No host chooser appears when an installation exists.

### Legacy upgrade

Run on the Host from any existing deployment: `~/.local/share/vorteo/source/scripts/upgrade.sh` (or the copy beside a legacy deployment). It detects what exists and adds the rest:

| Found                                  | Upgrade                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container-only `install.sh` deployment | Generates the Host plan from the deployment, installs the Host extension adopting the existing container, then moves Dev to gate mode with rollback |
| Host installation in Tailscale mode    | Moves Dev to gate mode with rollback                                                                                                                |
| Current architecture                   | Updates images and releases only                                                                                                                    |

Adoption keeps Dev's identity, home, workspace and agents. The existing pairing and settings migration handle the first binding; that path is the safety net, not the default.

The in-app Vorteo updates page on an installation without a Host shows the one Host command to run instead of an error.

## Not in this project

- Linux Hosts. The Host extension is macOS-only; Linux owners keep the standalone container until systemd support exists.
- The private custom domain stays an optional step after install, because it needs the owner's DNS credentials.

## Acceptance

- On a Mac with no Vorteo state, the one command produces an installation where the welcome page signs in, both environments connect, no duplicate System project appears, Accounts & profiles shows no conflict, and Dev's direct connections to the tailnet, Host and local network fail while normal tools work through the gate.
- A container-only deployment upgraded with `upgrade.sh` reaches the same state with its Dev identity, home and workspace preserved.
