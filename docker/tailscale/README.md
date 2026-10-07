# Optional preview broker and host recovery

Install Vorteo through the [multiplex installer](../multiplex/README.md). The image already contains Tailscale and serves Vorteo over private HTTPS. This directory contains that runtime support plus optional macOS host tools for agent-managed workspace previews and recovery. These tools are not required for ordinary Vorteo access.

Set `PASEO_SOURCE` to the checkout and `PASEO_DEPLOYMENT_DIR` to the private installation. The broker requires the standard `data/home` bind layout and a deployment directory outside agent-writable mounts. Python 3 and an awake, logged-in macOS user session are required for these optional host tools.

Before installing a broker, grant intended users the container node's preview TCP range 32768 through 60999. Review overlapping grants; the installer does not broaden tailnet policy. Each installation has its own broker and recovery labels, derived from its deployment path. Legacy jobs migrate only when their script belongs to that installation.

## Recovery

On the macOS Docker host, review the scripts, then install recovery using the configuration written by the broker installer:

```sh
PASEO_HOST_CONFIG="$PASEO_DEPLOYMENT_DIR/host-config.json" \
  python3 "$PASEO_SOURCE/docker/tailscale/install-host-recovery.py"
```

It copies the worker outside the checkout and installs a login agent that checks once per minute. An awake, logged-in Mac is required. This does not bypass FileVault or start Docker before login.

From the private deployment directory:

```sh
python3 host-recovery.py status
python3 host-recovery.py pause
python3 host-recovery.py resume
```

Pause before planned Docker maintenance or rollback. The worker starts Docker if absent, with three attempts spaced ten minutes apart. It starts an existing stopped serving container with three attempts spaced five minutes apart. It never recreates a container or restarts a running unhealthy daemon. A running rollback container suppresses replacement recovery. Restore operations run as the agent user with all capabilities removed. Review private `recovery-status.json` and logs when manual attention is needed.

## Preview lifecycle and private HTTPS

On the Mac host, run these commands from this source directory, then install against the retained serving container:

```sh
python3 -B test_https_broker.py
python3 -B test_host_recovery.py
python3 -B test_launch_agent.py
node --test initialize-web.test.mjs
python3 install-https-broker.py --container EXISTING_NAME \
  --allowed-root /absolute/development/root --rollback RETAINED_ROLLBACK_NAME
```

The installer uses Docker mount metadata to locate the existing deployment. It rejects host code or policy targets beneath writable container mounts, preserves configuration backups, installs a bounded login consumer, and updates the persistent helper and instructions without restarting Vorteo. Run the same installer after upgrading these tools. The image also distributes the helper module for new installations. Keep the existing Tailscale identity and grants. Review the current packet-filter scope; installation must not broaden it. The runtime fails closed if that scope or node identity changes.

Agents use the [approved helper workflow](AGENT-INSTRUCTIONS.md). A local preview request means a verified private Tailscale HTTPS link. To admit current and future active registered projects and worktrees without individual grants, install with `--workspace-policy registered`. Each workspace must still resolve through verified host bind mappings, including the persistent container home. Registration does not grant access to host directories outside those mappings. Symlinks, archived workspaces, changed pinned paths, unregistered services, and unsafe listeners remain rejected. The installer retains this policy on subsequent runs when the option is omitted.

The default `--workspace-policy approved-roots` retains the existing restricted behavior: local workspaces must be beneath an allowed root and worktrees additionally require an exact workspace grant. For that mode, use `--approve-workspace WORKSPACE_ID=/absolute/container/worktree/path`. Keep passing the current allowed roots on reinstall; switching workspace policy does not change tailnet grants, node identity, or unrelated mappings. The installer backs up the previous configuration and broker code before applying the update, without restarting Vorteo.

Requests contain only lifecycle operation, workspace ID, service name, request ID, timestamp and optional preferred frontend port. The filesystem inbox is the only request interface. No Docker or Tailscale socket is exposed to agents.

The host resolves live daemon workspace and script records, checks the configuration fingerprint and managed terminal, and verifies the actual loopback listener process before publishing. It reserves a stable frontend, writes startup origin configuration, and starts the registered command through the existing unprivileged daemon CLI. The command wrapper supplies `PASEO_PREVIEW_ORIGIN` at launch. Applications must consume it where framework hosts, callback URLs or WSS origins need explicit configuration. A caller's environment does not reach a daemon-launched service.

The mapping ledger, deduplication journal and lock remain outside agent-writable mounts. Repeated start adopts an unchanged owned mapping without probing its occupied frontend or replacing it. Stop persists its barrier and removes the exact owned route before stopping the service. Old queued starts and replays cannot undo a stop.

Install with `--restore-after-restart` to restore verified previews after a daemon or retained-container restart. The broker records the daemon process identity after successful verification. When that identity changes, it removes the stale route and starts the same service only if its workspace remains active and its path and command fingerprint are unchanged. It retains the frontend reservation and verifies the new managed terminal, loopback listener and HTTPS certificate before publishing. Recovery makes at most three start attempts per new daemon, with increasing delays. An uncertain start response or unexpected running replacement requires an explicit start rather than adoption.

Use the preview helper's stop operation to durably cancel recovery, including during maintenance. A service observed stopped in the same daemon also remains stopped; recovery does not supervise application crashes. Archived, moved or reconfigured workspaces do not recover automatically. Enabling recovery never revives old stopped reservations. Omit the installer option to preserve existing policy, or use `--no-restore-after-restart` to disable it. Without this option, previews still require explicit start after restart. Container downtime remains downtime; the broker restores service when the container and daemon return.

The consumer checks every ten seconds while the user session is available. It has bounded file sizes, queue batches, command timeouts and reconciliation work. It is not a synchronous process-death firewall: an external process exit or replacement can precede the next check. Use the helper for deliberate stop/restart so route removal precedes process termination. Never run a new unrelated listener on a reserved backend before its route is removed. Unexpected route changes require administrator review and are never evicted.

Only `ready` receipts contain usable URLs after certificate-validating HTTPS and HTTP checks. Browser rendering, Web Crypto, clipboard permissions and application origin checks are separate acceptance checks. HTTPS adds neither application authentication nor tailnet authorization. Keep direct listeners' forwarded-header trust disabled and preserve explicit bind scope. Tailscale Serve supports WebSocket upgrades; frameworks with explicit HMR client origins must use the reserved HTTPS origin and WSS.

`https-preview.py WORKSPACE_ID SERVICE HTTPS_PORT` remains an administrator compatibility entry point using the same policy, ledger and lock. Never use `serve reset`, enable Funnel or replace another mapping to claim a port.

## Broker rollback

Stop each broker-managed preview with the helper when its process may stop. This removes and verifies only its owned mapping, and keeps the frontend reservation. For a capability-only rollback that preserves processes, run `python3 uninstall-https-broker.py` from the trusted deployment directory. It unloads this instance's owned login job, verifies each exact route before removal and disables request handling without resetting Tailscale or touching unrelated mappings. Keep the helper's environment loader and origin files for already-wrapped commands. Restore backed-up recovery code/configuration only after checking that its container identities still match. Do not restore stale whole-home or whole-Tailscale state.

An awake, logged-in Mac and available Docker are prerequisites. FileVault unlock, login and host wake are not supplied by this broker. Installation or recovery does not authorize restarting Vorteo, Docker or unrelated services.

## Backup and replacement

Coordinate active work and announce immediately before interruption. Pause recovery, preserve deployment configuration and exact image references, stop production with its configured grace period, then take a consistent home and Tailscale-state backup. Keep the old stopped container and image for rollback. Never run two daemons against the same persistent home.

Recreate with the reviewed candidate, preserving mounts, environment, accounts and persistent web directory. Verify daemon health, node identity, provider catalogs, GitHub identity and repository discovery, served release, preview restoration and physical-device access. Rollback means stopping the replacement before starting the retained old container with its saved configuration. Keep recovery paused while the old container serves. Do not remove volumes, prune rollback artifacts or unenroll host Tailscale as part of cleanup.

Use focused tests with disposable state. `python3 -B test_host_recovery.py` verifies bounded recovery behavior without touching Docker. Record installation-specific test results privately.
