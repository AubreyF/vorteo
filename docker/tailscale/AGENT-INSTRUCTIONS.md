# Private workspace previews

The installed HTTPS broker is the approved exception for routine preview lifecycle requests. Agents may use the commands below for authorized local development work without per-service host approval. The host policy decides eligible workspaces and ports. This does not authorize unrelated work or external publishing.

Use the existing workspace. Under the host's `registered` workspace policy, active registered local projects and worktrees with verified host paths need no individual grant. Under `approved-roots`, local workspaces must be inside an approved root and worktrees also need an exact workspace grant. Archived and symlinked workspace paths remain rejected, as do changes to previously pinned workspace paths. Registration never grants access to unmapped host paths. If an authorized preview is blocked by host policy, prepare a continuity prompt for Codex on the primary host to apply the policy update; do not ask the owner to run isolated diagnostics or pretend owner authorization is missing.

```sh
paseo-preview list --workspace WORKSPACE_ID
paseo-preview start preview --workspace WORKSPACE_ID
paseo-preview start preview --workspace WORKSPACE_ID --https-port PORT
paseo-preview status preview --workspace WORKSPACE_ID
paseo-preview status
paseo-preview restart preview --workspace WORKSPACE_ID
paseo-preview stop preview --workspace WORKSPACE_ID
```

Start requests private HTTPS by default. Only a `ready` result contains a verified usable URL. `pending` means startup or verification is incomplete. `failed` includes a diagnostic. A timeout is not permission to kill listeners or restart Vorteo. Repeat start adopts the same reservation. Use a new status request to inspect an uncertain result. Stop removes the owned mapping before stopping the managed service and prevents queued older starts from reviving it. Restart retains the HTTPS port. Never use another service's reserved frontend as a backend port.

The helper sends bounded JSON through the installed filesystem inbox. Do not write ad hoc requests or change broker installation markers. Host policy, executable code and mapping ownership are outside agent-writable mounts. Agents must not execute host administration scripts, use Docker, access the protected Tailscale socket or state, request operator privileges, change grants, enable Funnel, or alter unrelated mappings.

Define a `service` script in `paseo.json` using the framework's real port options and `PASEO_PORT`. Before a stopped service's first launch, the helper wraps its existing command with `paseo-preview env`. That wrapper supplies `PASEO_PREVIEW_ORIGIN` from the host's reserved origin file when the daemon launches the command. Caller environment variables do not propagate through the daemon. Apps must consume that exact origin for host checks, callback URLs, write-origin checks and WSS/HMR configuration where required. Already-running services are adopted without changing their startup environment; use an authorized preview restart when an origin change must take effect.

Bind loopback for Tailscale Serve. Preserve any explicitly approved private listener scope; do not switch an app to a wildcard binding merely to pass readiness. Trust forwarded headers only on the trusted loopback path. Direct clients must not gain trust by supplying forwarded headers. Keep host checks and snapshot/hash verification enabled.

HTTPS does not add application authentication, change tailnet access, or grant clipboard/microphone permission. Test the rendered application, not only HTTP health. Keep URLs, credentials, clipboard content and installation receipts out of public source or logs.

The broker runs while the Mac is awake and the user session is available. Administrators can opt into restart recovery for previously verified previews whose workspace and service configuration remain unchanged. Recovery retains the HTTPS reservation and verifies the replacement managed listener. Explicit stops, same-daemon service exits, archived workspaces and configuration changes remain stopped. Without that policy, use explicit start after a daemon restart. Legacy preview restoration remains separate for services not adopted by the broker. Host startup cannot bypass FileVault or login. Agents cannot administer host recovery.

## Owner preview preference

When the owner requests a local preview, provide a verified private Tailscale HTTPS URL in every project and worktree. The request authorizes the managed preview lifecycle without a separate approval question. A localhost-only URL does not fulfill the request. Keep Funnel disabled and preserve path, listener ownership, and origin checks. Before preparing a host continuity prompt, check available skills and clients. Use the installed `installation-maintenance` skill for supported Host or Dev daemon restart requests and status queries, retaining owner approval for each restart. Host policy changes and other operations without a supported tool route require a self-contained continuity prompt, including the concrete blocker, completed preparation, validation, remaining work, existing authority, and acceptance checks.

## Preview workspace reuse

A preview belongs to the existing task workspace. Reuse its workspace ID, configured service and HTTPS reservation on every start or restart. A preview request never authorizes creating another project, workspace, copied checkout or proxy-only workspace. A host policy failure must go through the host continuity workflow; do not try alternate directories to evade it.

Keep code isolation separate from preview registration. When starting a new implementation task that requires a worktree, establish that task's workspace in the worktree before launching its agent. Reuse an existing dedicated task worktree on continuation. Do not add a second sidebar workspace merely because an existing task edits an isolated worktree. Attach the service to the owning task workspace and explicitly configure its command for the verified task worktree, retaining host mapping and listener checks. If the host cannot validate that source path, use the host continuity workflow instead of creating another registration.

Before starting work, check the current workspace for an existing agent handling the same submitted task. Do not independently repeat its implementation. Preserve code and conversation history before consolidating duplicate task or preview records. Test fixtures belong in an isolated test daemon, with teardown, rather than the owner's project registry.
