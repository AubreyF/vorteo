# Vorteo

One container includes Vorteo, its web UI, Codex, Pi and Tailscale. Each installation has its own accounts, workspace and private network identity. Linux AMD64 and ARM64 are supported; macOS runs it through Docker Desktop.

Installation agents: follow the [installation agent instructions](../../README.md#instructions-for-installation-agents).

1. Install Docker with Compose on the host and Tailscale on the devices you will connect from. The host does not need a separate Tailscale installation.
2. From this checkout, run:

   ```sh
   ./docker/multiplex/install.sh "$HOME/paseo-instance"
   ```

3. Complete the Tailscale login. Open the HTTPS address printed by the installer and use the password saved in `paseo-instance/.env`.
4. Enable **Vorteo** in the sidebar, connect your provider accounts, and create a preset. See [account setup](../../docs/custom-providers.md#multiple-profiles-for-the-same-provider).

To keep every new project in one folder that the container sees at the same path, set `PASEO_PROJECTS_FOLDER` to an absolute path, such as `PASEO_PROJECTS_FOLDER="$HOME/dev"`, before running the installer. See [Projects folder](../../docs/execution-installation.md#projects-folder).

The installer builds the image from this checkout, then creates private persistent storage. The first build downloads dependencies and takes longer than subsequent builds. To reuse an existing image, pass its reference as the second argument.

An explicitly authorized [macOS host extension](../../docs/execution-installation.md) can attach to this container and add full-account host execution in one protected interface. That separate setup requires host Tailscale and does not recreate this container.

[Build, update and troubleshoot](../../docs/docker.md). [Optional workspace previews](../tailscale/README.md). Keep the deployment directory outside this checkout.
