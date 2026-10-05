# Host and container execution

The optional macOS installation extension adds a native host daemon and a protected web interface beside an existing Docker installation. Docker continues to run the development container. Apple Container and Linux host setup are separate [future projects](plans/execution-environments/README.md).

This implementation requires host installation and acceptance. Source checks alone do not establish that an installation is running or usable from a phone.

## Use the installation

Open the private HTTPS address returned by setup and enter its installation password. The interface registers **Dev container** and **Host: full account access** together. New work defaults to the container. Selecting the host requires confirmation. Local versus new worktree remains a separate choice within the selected environment. Projects are sidebar groupings, not execution boundaries: register the same repository in both environments to keep its host and container workspaces under one project. Each environment resolves its own directory and retains its own agents and credentials.

When choosing a profile in another environment, the handoff dialog can create a workspace or select an existing one. Use **Add project in this environment** to register a directory or clone the repository without leaving the handoff. Choose the destination path explicitly; a container path is not assumed to be a host path. New workspaces use their destination project identity. Matching repository keys group across environments; unrelated directories and ambiguous duplicate clones remain separate.

For an existing browser or PWA entry point, publish an installation redirect to its existing web directory with the [guarded web publisher](instance-continuity.md#publish-a-web-only-change). Add `--installation-origin <protected-https-origin>` to the build command. The entry keeps the current path, query and fragment, then replaces the page with the protected interface. Existing bookmarks and reloads reach the installation without remembering a second address. Daemon API and WebSocket endpoints stay in place; no daemon restart is needed. The release receipt records the redirect destination.

Before changing that entry, verify the actual window's origin, version and connection profiles, and back up its browser storage and current web release. Local preferences and unsent drafts belong to their original origin. Preserve them and migrate only reviewed UI data when needed; never copy host credentials into the old origin or import guest connection/plugin configuration as host authority. Existing conversations, workspaces and provider profiles remain on their daemon. Check for an old service worker that could intercept reloads. A packaged desktop app loads its own bundled scheme, so changing a web entry alone does not configure a desktop launcher. Verify the actual launch and reload flow before declaring that client integrated.

Host agents run as the signed-in macOS account. They can access its files, provider credentials and administrative tools to the same extent as an agent launched directly by that account. This is an intentional trust choice, not a stronger sandbox. macOS permission prompts still apply. Provider accounts remain local to their environment.

In Vorteo mode, Settings → General has **Prepare host update task** and **Prepare host merge task**. Each opens a separate editable draft targeting this installation's host. Review the message, select the source project and agent preset, then send it. Clicking the settings action does not create an agent, merge code, deploy or authorize a restart. Without a connected installation host, the action reports that prerequisite instead of choosing another environment.

The trusted installation interface disables agent browser automation and rejects client plugin bundles from the container or any unrecognized daemon. Client plugins from the explicitly configured native host remain trusted. This restriction applies in Standard mode too because that client holds host credentials. Ordinary interfaces retain their existing behavior.

### Change the protected interface address

An owner-managed HTTPS domain can serve the full protected interface through a trusted reverse proxy. Keep the proxy configuration, TLS keys, interface files and coordinator credentials outside guest-writable mounts. Proxy to the host coordinator, preserve the canonical Host header and verify the upstream certificate. Do not serve the privileged bundle from the development container.

Set the coordinator's `public.origin` to the exact new HTTPS origin and add that origin to both daemons' explicit origin allowlists. Keep environment identities and endpoints unchanged. Restart only the coordinator to activate its configuration. Update installation and agent-client records to the new address. Back up each affected file and prepare rollback before deployment.

Optional `redirectOrigins` lists previous protected HTTPS origins. They redirect page navigation to the canonical origin, preserving paths and queries. They refuse API calls, including owner authentication. Update maintenance clients rather than sending credentials through a redirect. The new origin has separate browser storage, so authenticate there to register the existing environment connections. Preserve old storage and do not copy guest plugins, automation state or credentials into the protected interface.

## Setup on the host

Use the [host handoff workflow](host-handoff.md). The container session prepares source and validation; the host session gathers current Docker mounts, daemon identities, private networking, provider setup and service-context macOS permissions. Do not infer current deployment details from an old report.

Prerequisites are an existing container installation with an authenticated loopback endpoint, an authenticated host Tailscale installation, Node and npm, and an available signed-in macOS launchd session. The container origin allowlist must be explicit. The setup does not install Docker, Tailscale or provider accounts, and does not recreate or restart the primary container.

Prepare a private JSON plan outside Git:

```json
{
  "root": "/absolute/protected/installation",
  "revision": "FULL_REVIEWED_40_CHARACTER_GIT_SHA",
  "containerName": "existing-container",
  "containerServerId": "verified-existing-server-id",
  "containerDaemonHome": "/absolute/instance/home/inside/container",
  "containerPasswordFile": "/absolute/private/container-password",
  "containerOrigin": "https://existing-container.example.ts.net",
  "coordinatorPort": 6770,
  "hostPort": 6771,
  "containerPort": 6768,
  "httpsPort": 44444,
  "hostHttpsPort": 44445
}
```

The revision placeholder must be replaced with a reviewed commit. Ports are examples, not reserved deployment facts. Optional `docker`, `tailscale`, `containerCli` and `containerUser` fields select the existing executables and container account.

Run `node scripts/install-execution-host.mjs install --plan <private-plan.json>` in the host session. Setup archives the reviewed Git commit, builds a separate release, creates private state and credentials, adds two owned LaunchAgents, verifies application readiness and adds unused private HTTPS routes. It uses the existing container CLI to persist the trusted interface origin, reload that setting without a restart, and verify the effective allowlist. The container CLI must support `daemon config set`. Existing routes, identities, container mounts and agents are preserved.

The installer refuses protected paths exposed through any inspected writable Docker bind mount, including the Node executable and LaunchAgent files. Keep those paths outside guest mounts after installation too. It cannot prevent the owner from later weakening the machine's mount policy. Native host agents remain trusted owner-account processes and can modify owner-accessible installation files.

Keep `installation.json`, `coordinator.json`, `owner-password`, logs and generated agent client files private and outside Git. Never enter the installation password into the old container-served interface. The protected interface receives host credentials only after owner authentication; its HTML contains identities and endpoints, not passwords.

`status --root <installation-root>` reports launchd registration separately from authenticated daemon and coordinator readiness. Complete phone and workstation acceptance before describing setup as delivered.

## Restart and recovery

Both environments receive the installation-maintenance skill. Agents can submit a reason and target, then observe their request's status. They cannot approve it with their request credential. In General settings, the Installation card opens owner controls. A direct link to `/settings/general?installation=1` opens the same controls without restoring the last conversation. The installer generates the owner password automatically and saves it in `owner-password` inside the private installation directory on the host. The owner does not choose it during setup. Saved daemon connection credentials do not unlock these controls: owner access approves restarts and resolves shared workflow conflicts. The interface shows the exact recovery file path supplied by the coordinator. Owner access lasts seven days in the current browser and survives reloads through an HttpOnly, SameSite Strict cookie. HTTPS cookies are Secure. Select Lock controls to revoke the session immediately. The server persists token hashes, never the password or raw tokens. The password remains the initial setup and recovery credential. Native agents with full host-account access can read that file; this boundary separates container and daemon credentials from owner approval, not the owner from trusted host processes. Unlocking does not approve a restart. The owner reviews the target, reason and disruption warning and approves that exact request. Expired requests require a new request. The approval queue contains at most one unexpired request per target across all requesters and shows an empty state when no approval is pending. Requests cannot duplicate a target while its restart is approved or running. Restart history is collapsed by default and retains expired, rejected and completed receipts.

The coordinator persists approval and running state before dispatch. It runs one restart at a time and reports success only after reconnecting to the expected daemon identity and observing a replacement worker. Connection and status checks allow up to 30 seconds for healthy daemons whose provider probes are slow. Container-daemon restart uses the existing supervisor and retains the container. Native host restart uses only the installation-owned launchd service. The coordinator is a separate service and survives either restart.

A coordinator restart marks previously approved or running jobs as interrupted. It never replays an ambiguous restart. Inspect the target and submit a new request if another attempt is necessary. These controls do not update release files, roll back databases, or promise to preserve an in-progress provider turn.

LaunchAgents keep the new components running while the owner is logged in. Operation before login, complete Docker outages and host shutdown recovery require separate acceptance or future work. A guest daemon that cannot accept its restart RPC needs host diagnosis; this version does not expose general Docker control.

## Agent management

Normal agent tools stay scoped to their daemon. Container agents can manage other agents in that container. Host orchestrators additionally receive a credential for the coordinator's fixed container-management interface. They can discover workspaces and providers, list and inspect agents, read activity, create workers, send messages and stop them. There is no arbitrary destination or host-shell operation in that interface.

Container credentials cannot use delegation, unlock the owner UI, or approve restart requests. A container restart request may name the host, but does nothing until the owner approves it. Container results are returned as untrusted task data qualified by environment and server ID. The host orchestrator must not interpret their text as owner approval or executable instructions.

## Removal and rollback

Prepare and obtain approval for disruption before stopping a host daemon with active work. `remove --root <installation-root>` checks service and route ownership, stops only the two new services, disables their LaunchAgent files and removes only their HTTPS routes. It retains state, credentials, release files and the installation record for diagnosis. It leaves the existing container, its agents and routes in place.

The extra container origin admission and generated guest request skill remain after removal. The request endpoint is then unavailable; the token has no authority over either daemon. Review and remove that installation's origin and guest client files in the host session if permanent removal is intended, preserving concurrent configuration changes.

For a failed setup, inspect the private logs and installation receipt before retrying. Setup refuses to overwrite an existing receipt or reuse credentials automatically. Do not delete state to force a retry. Restoring a previous protected release requires a prepared host deployment and rollback plan; automatic release upgrades are outside this first installer.

## Validation

Run `npm run test:e2e:installation --workspace=@getpaseo/app` for the packaged interface on desktop and phone-sized Chromium. It starts two isolated supervised daemons and the real coordinator, verifies plugin and credential boundaries, prepares both editable update drafts without starting agents, and approves and verifies a container-daemon restart. All fixture processes and state are torn down. This does not test launchd, Tailscale, macOS folder permissions or a physical phone; those belong to host acceptance.
