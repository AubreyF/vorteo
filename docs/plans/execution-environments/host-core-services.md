# Core services on the Host

Status: proposed October 28, 2026. Phases 0 to 3 are authorized for preparation in a task branch. Phases 4 and 5 are documented for discussion only. Nothing here is installed, and the current Docker-hosted services keep running until the owner approves a cutover.

## Goal

Keep the Vorteo interface, custom domains and Host agents available while Docker, a daemon or a release changes underneath them. Trusted, long-running services run natively on the Host. Less trusted work, agents, MCP servers and iterative builds run in containers. Vorteo development stops restarting the installation the owner uses to build other projects.

## Findings

These findings come from one macOS installation with a native Host and a Docker Desktop Dev container. Machine-specific evidence stays outside Git.

- **Docker sits on the critical path for every public entry point.** The protected interface is served by the native Host daemon, but the custom-domain gateway (Caddy and its own Tailscale node) runs as two Docker containers. A separately installed application, served through the Dev container's managed preview, sits behind that same gateway. A Docker Desktop failure takes both domains down even while the Host is healthy.
- **Dev carries its own network identity.** The Dev container runs `tailscaled` with `NET_ADMIN` and serves the Dev daemon and managed previews on its own tailnet name. The Host's Tailscale also forwards to Dev through Docker's published loopback port. Both paths fail together when Docker's port forwarding stops.
- **Most restarts are self-inflicted.** The installation builds and runs Vorteo at the same time, so every daemon delivery restarts the environment in use. About 53 of 706 commits in the four weeks before this plan changed restart, recovery or watchdog behavior.
- **Dev's writable layer is unbounded.** It reached about 195 GB. Agent scratch directories in the container's `/tmp` account for about 159 GiB across more than 13,000 entries untouched for a week. Nothing reaps them because the container rarely restarts and `/tmp` is not a mount. Retained Dev releases account for another 26 GB.
- **Idle provider processes hold memory.** 35 idle `codex app-server` processes held about 7.6 GB in Dev. The Dev daemon used about 10 GiB and the Docker VM about 15 GB of host memory with a 24 GiB cap.
- **Durable sessions already exist.** The session host keeps Claude and Codex sessions alive through worker and release restarts. It is off by default; Claude passed live acceptance and Codex has not.

## Target architecture

| Layer         | Runs                                                                                      | Trust                    | Failure effect                       |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| Host edge     | Native Caddy, a dedicated userspace `tailscaled`, static interface files, hosted web apps | Trusted owner account    | Must stay up; changes are rare       |
| Host services | Coordinator, Host daemon with durable sessions, session host, release builds              | Trusted owner account    | Restarts are invisible to clients    |
| Containers    | One daemon each, its agents, MCP servers, dev servers and iterative builds                | Less trusted, disposable | Only that environment's agents pause |
| Lab           | A second installation that receives every Vorteo build first                              | Separate machine or VM   | Never affects production             |

**Builds.** The Host builds and serves reviewed commits only, as the release pipeline already does. Building agent-written code runs it: install scripts, tests and dev servers execute with the builder's authority. Iterative builds therefore stay in containers. macOS-only builds (Xcode, signing, desktop packaging) run as Host jobs that take a committed revision, never an arbitrary agent shell.

## Container runtime

Target the Docker Engine API through one runtime adapter. Docker Desktop, OrbStack, Colima, Podman and Socktainer then become interchangeable on macOS. The same adapter works with native Docker or rootless Podman on Linux and with Docker or Podman on WSL2 on Windows.

Apple's `container` runtime (1.6.1, October 2026) runs one lightweight VM per container on macOS 26 and Apple silicon. It is not yet suitable for an always-on Dev environment:

- No restart policy or start at login; a pull request is pending.
- File change notifications do not cross bind mounts ([apple/container#141](https://github.com/apple/container/issues/141)), which breaks file watchers and hot reload.
- Networking can fail after a VPN connects ([#1307](https://github.com/apple/container/issues/1307)); Tailscale is a VPN.
- Memory released inside the guest is not returned to macOS.
- No Docker API or Compose. Socktainer adds the API with gaps in privileged mode and restart policies.

Reconsider it as a backend for disposable task sandboxes once restart policy and file change notifications ship. Nested virtualization requires M3 or later.

## Phase 0: stop the bleeding

Half a day. No restart.

- **Release channels.** Production installs only releases the owner promotes, including interface-only changes. A broken interface is also downtime, and promotion is one click.
- **Idle provider processes.** Release idle Codex app-servers and reap orphans when a worker starts.
- **Dev scratch retention.** The [scratch reaper](../../../docker/tailscale/scratch_reaper.py) reports top-level scratch entries with nothing modified for seven days, no process using them and no uncommitted or unpushed Git work. It is a dry run unless given `--delete`, and it rechecks each entry before removing it. Run it as the container's agent user, for example `docker exec -i -u <user> <container> python3 - --root /tmp < docker/tailscale/scratch_reaper.py`. Scheduling it inside the image is a later step. Keep retained releases to the current, previous and any pinned rollback.
- **Docker image review.** List stopped recovery containers and snapshot images for owner review before removal. Images share layers, so reported sizes overstate reclaimable space. Compacting Docker's disk image requires a tracked Docker restart and waits for the cutover window.

## Phase 1: take Docker off the critical path

Two to three days, prepared side by side. Cutover is one owner-approved window.

1. **Native edge.** Implemented as the [native gateway](../../private-domain.md#run-the-gateway-natively); see its cutover and rollback steps. Install Caddy with the Cloudflare DNS plugin as a pinned, digest-verified binary under the installation's private directory, supervised by launchd (systemd on Linux). Install a second `tailscaled` in userspace networking mode with its own state and socket, so the gateway keeps its own tailnet name and address. Migrate the existing gateway node's state at cutover so DNS records do not change.
2. **Hosted web apps.** Serve other trusted web applications from a built release on the Host, not from a development checkout or the Dev container. Each app gets its own launchd job, state directory and loopback port behind the native edge.
3. **Interface availability.** The edge serves the protected interface's static files and proxies API and WebSocket traffic to the Host daemon. A daemon restart then shows a reconnecting state instead of a failed page load.
4. **Previews through the Host.** Route Dev previews through the Host's native preview broker to Dev's published ports. Dev then needs no Tailscale node or `NET_ADMIN` capability.

Rollback for each step starts the previous containers again. Removal leaves state and credentials for diagnosis.

Acceptance: both custom domains and the protected interface stay reachable through a full Docker Desktop stop; a Host worker restart never returns a failed page load; Dev previews still open from a phone.

## Phase 2: invisible restarts

Three to five days.

- Turn durable sessions on by default once Codex passes live acceptance.
- Keep the listening socket open across worker swaps so connections are held, never refused.
- Clients reconnect without losing drafts, queued messages or scroll position.

Acceptance: a Host release upgrade during a running Claude turn and a running Codex turn shows no error and loses no output.

## Phase 3: lab installation and promotion

Two to four days, plus the lab machine.

- **Lab.** A second installation with its own state, Tailscale names, coordinator and accounts. It can run on a laptop that is not always online; the lab needs no availability. A Linux VM is an alternative that also qualifies Linux, but it cannot test launchd, desktop automation or Apple's runtime.
- **Lab as an environment.** Register the lab's daemon as an environment in the production interface. Vorteo work then runs from the owner's productive installation while its restarts happen on the lab.
- **Promotion.** Builds installs every integrated revision to the lab first. Production upgrades only when the owner promotes a lab-verified revision. A promotion is a recorded, digest-bound release selection that uses the existing tracked source-update workflow.

Lab setup on a second Mac:

1. Install the container installation and the [Host extension](../../execution-installation.md) on the lab machine with its own installation ID, Tailscale names and owner password. Never copy production state, credentials or the coordinator record.
2. Connect provider accounts to the lab separately. Lab agents never receive production credentials.
3. Add the lab's Host daemon to the production interface as a connected host, so Vorteo workspaces can run there.
4. Point Builds' lab delivery at the lab coordinator. Production delivery waits for a promotion.

The repository instructions currently tell Builds to install each integrated change on production. Changing that policy is a separate instruction change, reviewed with Builds when the lab is ready.

Acceptance: a week of Vorteo deliveries causes no production restart except the owner's promotions.

## Phase 4: multiple containers (for discussion)

Three to five weeks. Builds on [task containers through Docker](docker-task-containers.md), [environment grants](environment-grants.md) and [provider authentication](provider-auth.md).

- **Environments.** Every installation has the Host and one container named `dev`. Users can create more containers. A workspace selects its environment when it is created, defaulting to a project setting. Switching environments creates a new workspace. A container's directory grants decide which folders its workspaces can use.
- **Inheritance by risk tier.** One global switch does not fit both a trusted `dev` and a sealed experiment.

  | Tier                         | Examples                                                                     | Default                                |
  | ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
  | No authority                 | CLI tools, skills, stateless MCP servers                                     | Inherited; excludable per container    |
  | Credentials                  | Provider accounts                                                            | Synchronized; excludable per container |
  | Authority over other systems | Vorteo control tools, signed-in browser profiles, Host folders, write tokens | Never inherited; explicit grant only   |

  Two templates cover the common cases. **Standard** follows the installation baseline, so new tools reach it automatically. **Sealed** inherits nothing and starts from an allowlist. Synchronizing every account into every container means one compromised container exposes every account, so Sealed containers start without accounts and the credential broker remains the long-term answer.

- **Capability view.** One matrix with capabilities as rows, grouped by tier, and environments as columns. Each cell shows Available, Pending sync, Excluded, Not granted or Failing with its reason. Cells report what the environment verified (MCP handshake, CLI version, account check), not only what is configured. On phones, the matrix pivots to one list per environment.

## Phase 5: other platforms (for discussion)

- Apple `container` backend behind the same runtime adapter: one to two weeks after its blockers ship.
- Linux Host as `systemd --user` services: see [Linux Host](linux-host.md).
- Windows Host with containers on WSL2: one to two weeks, after the Linux Host settles.

## Gains and losses

Gains: Docker outages stop being Vorteo outages; memory and disk return to the Host; restarts stop interrupting work; Vorteo development no longer disrupts production; several containers with clear trust levels; one runtime adapter across platforms.

Losses: native services need launchd, systemd and Windows service definitions instead of one Compose file; production receives daemon changes only when promoted; a lab adds a second installation to maintain; removing old images and scratch directories is irreversible, so each removal needs owner review.
