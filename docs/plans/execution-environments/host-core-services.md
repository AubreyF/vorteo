# Core services on the Host

Status: proposed October 28, 2026; updated October 29, 2026. Phases 0 to 2 are implemented in source on the core-services branch, pending integration into `main`. On the owner installation, the owner reports the native gateway and the Vorton Host release live. The server and client fixes still need installation. Phase 3 is owned by the [lab installation guide](../../lab-installation.md). Phases 4 and 5 are documented for discussion only.

## Goal

Keep the Vorteo interface, custom domains and Host agents available while Docker, a daemon or a release changes underneath them. Trusted, long-running services run natively on the Host. Less trusted work, agents, MCP servers and iterative builds run in containers. Vorteo development stops restarting the installation the owner uses to build other projects.

## Findings

These findings come from one macOS installation with a native Host and a Docker Desktop Dev container. Machine-specific evidence stays outside Git.

- **Docker sits on the critical path for every public entry point.** The protected interface is served by the native Host daemon, but the custom-domain gateway (Caddy and its own Tailscale node) runs as two Docker containers. A separately installed application, served through the Dev container's managed preview, sits behind that same gateway. A Docker Desktop failure takes both domains down even while the Host is healthy.
- **Dev carries its own network identity.** The Dev container runs `tailscaled` with `NET_ADMIN` and serves the Dev daemon and managed previews on its own tailnet name. The Host's Tailscale also forwards to Dev through Docker's published loopback port. Both paths fail together when Docker's port forwarding stops.
- **Most restarts are self-inflicted.** The installation builds and runs Vorteo at the same time, so every daemon delivery restarts the environment in use. About 53 of 706 commits in the four weeks before this plan changed restart, recovery or watchdog behavior.
- **Dev's writable layer is unbounded.** It reached about 195 GB. Agent scratch directories in the container's `/tmp` account for about 159 GiB across more than 13,000 entries untouched for a week. Nothing reaps them because the container rarely restarts and `/tmp` is not a mount. Retained Dev releases account for another 26 GB.
- **Idle provider processes hold memory.** 35 idle `codex app-server` processes held about 7.6 GB in Dev. The Dev daemon used about 10 GiB and the Docker VM about 15 GB of host memory with a 24 GiB cap.
- **The interface already survives Host restarts; its connection does not.** The installation coordinator serves the interface and keeps running through Host restarts. The app's WebSocket to the Host daemon drops for 4 to 32 seconds per restart (median about 10), and the client's backoff can add up to 20 more. See [invisible Host restarts](invisible-restarts.md).
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

1. **Native edge.** Implemented as the [native gateway](../../private-domain.md#run-the-gateway-natively) and live since October 29, 2026: the custom domains moved to it by DNS, with the Docker gateway kept as rollback. Install Caddy with the Cloudflare DNS plugin as a pinned, digest-verified binary under the installation's private directory, supervised by launchd (systemd on Linux). Run a dedicated `tailscaled` in userspace networking mode as its own new node, beside the Docker gateway, and move DNS to it. Do not copy the Docker gateway's node state; see the guide.
2. **Hosted web apps.** Serve other trusted web applications from a built release on the Host, not from a development checkout or the Dev container. Each app gets its own launchd job, state directory and loopback port behind the native edge. The owner chose this for the Vorton application on October 28, 2026.

   A Host release is safe only if the Host never loads code from a folder Dev agents can write. Before October 29, 2026, Vorton ran from its development checkout and kept live state in folders that also hold agent scratch and candidate builds. Some of that state is executable: the server imports a private Rolodex bundle and optional adapters from those folders at runtime. A Vorton Host release therefore needs:
   - **Code from the release only.** The release is a reviewed Vorton commit plus the private bundles it loads, built once and digest-pinned. Adapters that are configured today through runtime folders become release contents or an explicit Host configuration.
   - **State outside guest mounts.** Live state moves to a Host-owned directory at cutover, copied from the inventoried live paths and nothing else. Dev agents then work against a copy, and changes reach live data through the application itself or a reviewed promotion, never by writing the live folders.
   - **One writer.** The Dev copy stops before the Host copy starts, as with the gateway cutover.

   The [hosted app tool](../../private-domain.md#serve-a-trusted-web-app-from-a-host-release) implements this. History: on October 28, 2026 the owner approved moving live state to a Host-owned folder, with a Dev copy for development and reviewed promotion, and a rehearsal release matched the Dev copy. The owner reports that Vorton has run from the Host release since October 29, 2026.

3. **Interface availability.** The edge proxies the custom domain straight to the coordinator on loopback and holds requests while the coordinator restarts. The coordinator already keeps the interface loading through Host daemon restarts.
4. **Previews through the Host (deferred).** Dev previews already use a Host-side broker, but it publishes them on Dev's own Tailscale node through `docker exec`. Publishing them on the Host's node instead needs three changes: recreate Dev with its preview range (32768 to 32799) published on Host loopback, add a broker runtime that verifies the listener inside Dev and serves the published port from the Host's node, and move Dev's daemon route to the Host's existing forward. Dev would then need no Tailscale node or `NET_ADMIN` capability. Previews still stop when Docker does, so the availability gain is small; the main gain is removing a privileged network service from Dev. Schedule it with the next planned Dev recreation, not as a standalone restart.

Rollback for each step starts the previous containers again. Removal leaves state and credentials for diagnosis.

Acceptance: both custom domains and the protected interface stay reachable through a full Docker Desktop stop; a Host worker restart never returns a failed page load; Dev previews still open from a phone.

## Phase 2: invisible restarts

Three to five days.

- Turn durable sessions on by default for new installations once Codex passes live acceptance. This Host already runs with them on. The installer must write the setting, and the session host job needs systemd and Dev support.
- Shutdown no longer stalls on a peer that ignores the close frame, and clients retry every 500 ms after a daemon announces its shutdown. Both are implemented on the task branch and not yet installed.
- Have the coordinator front the daemon's WebSocket port and hold upgrades while the daemon restarts, so connections wait instead of failing. This needs a reviewed Tailscale Serve route change; see [invisible Host restarts](invisible-restarts.md).
- Clients reconnect without losing drafts, queued messages or scroll position.

Acceptance: a Host release upgrade during a running Claude turn and a running Codex turn shows no error and loses no output.

## Phase 3: lab installation and promotion

The [lab installation guide](../../lab-installation.md) on `main` owns this. A lab is an ordinary installation, on a second machine, that develops Vorteo and installs its own changes. Production updates only to a revision the owner chooses. The owner chose a separate Mac for the lab on October 28, 2026; a separate workspace now owns that setup and the promotion workflow.

Acceptance: a week of Vorteo deliveries causes no production restart except the owner's chosen updates.

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
