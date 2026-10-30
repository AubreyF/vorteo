# Container operations

This fork runs the Vorteo daemon, agents and provider tools inside Docker. The Standard and Vorteo client modes use that same daemon. Start with the [installer](../docker/multiplex/README.md); there is no separate native-daemon installation path. Browser and mobile clients run on their own devices.

## Build and install

From the repository root:

```sh
./docker/multiplex/install.sh "$HOME/paseo-instance"
```

The image builds for Linux AMD64 or ARM64. On macOS use Docker Desktop; on Windows use Docker's Linux-container backend. The installer needs Bash and Docker Compose, not host Node, Python or Tailscale. Only mount projects the agents should access. The default workspace is an empty private directory; clone projects into `/workspace` from the container.

Installation generates a password and separate random instance name, pins the image to a digest or local image ID, and keeps state outside the checkout. Startup waits for Tailscale enrollment, configures private HTTPS 443, and starts Vorteo as a non-root user with an exact hostname/origin. The daemon binds container loopback; Compose publishes no host ports unless `PASEO_HOST_LOOPBACK_PORT` is set for the [macOS Host extension](execution-installation.md#setup-on-the-host), which publishes the daemon on host `127.0.0.1` only. Existing HTTPS routes are never replaced to claim 443.

If enrollment is interrupted, run `./connect.sh` from the deployment directory. Approve HTTPS in the tailnet administration page if Tailscale requests it; the container logs include the enablement link. Review the complete tailnet policy before admitting other users: permit only intended clients to this node's TCP 443. Keep Funnel disabled. The optional preview broker has its own port requirements.

The installer builds your checkout locally and pins the resulting image ID. No published image or registry account is required. The [Container workflow](../.github/workflows/docker.yml) checks AMD64 and ARM64 builds without publishing images. To reuse a reviewed local or registry image, pass its reference as the installer's second argument.

## Accounts and tools

Connect accounts using [provider configuration](custom-providers.md#multiple-profiles-for-the-same-provider). The bundled Codex and Pi versions are pinned in the Dockerfile. Authentication happens after installation and stays in the persistent home. Different accounts in one container are available to that container's OS user; they are not separate security sandboxes.

From the private deployment directory, run administration commands as `paseo`:

```sh
docker compose exec --user paseo paseo paseo daemon status --json
docker compose exec --user paseo paseo codex login --device-auth
docker compose exec --user paseo paseo gh auth login
docker compose exec --user paseo paseo bash
```

For additional Claude accounts, use **Settings → Providers → Add provider → Claude Code (Claude account)**. Start sign-in, open the browser link, and paste the returned code into the account panel. Each account gets its own configuration directory. New images install Claude Code with the pinned `PASEO_CLAUDE_PACKAGE` build argument.

For the built-in Claude Code provider, open the container shell above and run `claude auth login`, then `claude auth status`. Open the URL printed by Claude in your browser and follow its prompts. You can also use Vorteo's Terminal, which already runs inside the container. If `claude` is missing, install Claude Code inside the container as `paseo` using the [official installation instructions](https://code.claude.com/docs/en/setup). Signing in on the Docker host does not sign in the container. Return to Claude's provider details and select Refresh after login.

For an additional Codex account configured manually, give its provider a distinct `env.CODEX_HOME` under `/home/paseo`, then supply that same path with `docker compose exec --user paseo -e CODEX_HOME=/home/paseo/ACCOUNT paseo codex login --device-auth`. Existing installations need a coordinated daemon restart after manual provider configuration changes.

New homes enable Vorteo's agent-tool injection for managed workers. Existing configuration is preserved. Use `profileId` for preset launches as described in [agent operation](../skills/paseo/SKILL.md).

Local inference is optional. MTPLX runs natively on a Mac and is reached from Pi over its authenticated endpoint. Merge [the Pi template](../docker/multiplex/pi-models.example.json) into `/home/paseo/.pi/agent/models.json`, set the real model ID and limits, and add `MTPLX_API_KEY` to the deployment `.env`. Recreate the instance during maintenance to apply environment changes. Start with one managed worker; endpoint reachability does not prove model availability or capacity.

## Updates and rollback

Updates interrupt this instance's tasks. Coordinate a maintenance window and back up its state first. Build your updated checkout from its repository root, then update the deployment:

```sh
docker build --build-arg PASEO_BUILD_COMMIT="$(git rev-parse HEAD)" -f docker/base/Dockerfile -t paseo-multiplex:review .
"$HOME/paseo-instance/update.sh" paseo-multiplex:review
```

The updater retains the previous `.env` as `.env.previous`, checks the new image contract, and replaces only this Compose service. It does not remove orphan containers, delete volumes or automatically roll back a failed update. Use the previous image reference with the same command for an explicit rollback. An image rollback does not reverse data or project edits.

Untouched bundled web assets follow image updates. A separately published web release is preserved; use [instance continuity](instance-continuity.md) to replace it deliberately. Old hashed assets remain available for open clients.

Back up the deployment's `.env`, home, workspace and Tailscale volume while the instance is stopped. Use `docker compose stop paseo` and `docker compose start paseo`; never run two instances against the same home or identity. Do not use `docker compose down -v` on retained state. Keep backups and image receipts private.

## Existing installations

Do not run the fresh installer over an existing deployment. The updater requires the new installation marker and intentionally refuses legacy directories. Preserve the current private Compose files, exact home/workspace mounts, Tailscale identity volume, web release and rollback image. Pause optional host recovery before maintenance.

For a reviewed migration, compare the rendered old and new Compose configurations locally, without sharing their credential-bearing output. Map the existing identity volume explicitly, retain mounts, and check that the node's existing HTTPS 443 route points to this daemon. Recreate only after coordinating active tasks and taking a consistent backup. The old hostname-file mount is no longer needed by the new runtime; do not discard its identity volume. Reinstall optional broker tools against the serving container afterward. Record destination acceptance in the [private handoff](host-handoff.md).

## Troubleshooting

Run `docker compose ps` and `docker compose logs --tail=100 paseo` from the private deployment directory. An unhealthy container before enrollment is expected. Enrollment, node approval, HTTPS enablement and an occupied Serve route require administrator action; a timeout does not authorize restarting an active instance.

Use `docker compose exec --user paseo paseo paseo provider diagnostic PROVIDER --json` for provider failures. Check mounted-file ownership if the non-root user cannot access a project. Never recursively change ownership of an existing project tree to fix an unrelated startup error.

Docker must remain running and the host awake. Automated host recovery and agent-managed HTTPS previews are [optional macOS tools](../docker/tailscale/README.md); ordinary Vorteo access does not depend on them. Xcode and the iOS simulator do not run inside this Linux environment.

## Share host project folders

A container cannot open a host folder until it is mounted. `~` in legacy path inputs means the container user's home, not your host home. New hosts advertise a folder browser that distinguishes shared host folders from container home and workspace storage. Host paths entered in that browser resolve through the installation's explicit shares.

From the deployment directory **on the host**, stage a folder:

```sh
./share-folder.sh "$HOME/Documents/MyProject"
```

Review `shared-folders.pending.json`. The command preserves existing shares and stages a bind mount plus matching host-to-container path metadata. Missing source folders are rejected instead of silently creating empty directories. Sharing a parent folder includes its descendants. Shared folders are writable by agents, subject to host filesystem permissions; choose only folders you intend them to modify.

When active tasks can be interrupted, apply the change:

```sh
./share-folder.sh --apply
```

Applying recreates this container. It preserves the existing home, workspace and network identity volumes. The updater includes the active shared-folder configuration in future updates. Keep the generated JSON and its previous version private, beside the deployment's `.env`.

In **Add project**, choose **Open a folder**, **New project folder** or a GitHub clone. Each opens the same folder browser. Shared folders are listed by host path; container storage appears as Container home and Container workspace. Open subfolders, then open the current folder, type a name to create a folder there, or clone into it. You can enter a host path such as `~/Documents/MyProject` after configuring shares; `~` means the host home. Agents still use the container paths. Symlinks leaving a shared root require sharing their targets separately.

For an existing installation, copy `share-folder.sh`, `shared-folders.mjs` and the updated `common.sh` from `docker/multiplex` into the private deployment directory after reviewing local lifecycle customizations. Update the daemon before using the new browser. Older daemons retain their existing path input; the app does not infer host sharing from a path string. Docker Desktop must permit sharing the source folder, and the non-root container user needs directory access. The command does not change ownership or permissions recursively.
