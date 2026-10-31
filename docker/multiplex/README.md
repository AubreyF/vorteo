# Vorteo Dev container

Install and upgrade Vorteo with one command on the computer that runs Docker:

```sh
curl -fsSL https://github.com/terran-labs/vorteo/releases/latest/download/install.sh | bash
```

It creates the Dev container from these files when you choose one, adopts an existing deployment made by `install.sh`, and keeps its identity, home, workspace and agents. Installation agents: follow the [installation agent instructions](../../README.md#instructions-for-installation-agents). Later updates, including the Dev container image, happen in the interface.

The rest of this page is reference for the container the installer manages.

One container includes Vorteo's daemon, Codex, Pi and Tailscale. Linux AMD64 and ARM64 are supported; macOS runs it through Docker Desktop. The Projects folder, `~/dev` by default, appears at the same path inside the container. See [Projects folder](../../docs/execution-installation.md#projects-folder).

`install.sh` and `update.sh` are the lower-level container tools. Run them yourself only to repair or inspect a deployment, and never run `install.sh` over an existing deployment. `install.sh` builds the image from this checkout and creates private persistent storage; pass an existing image reference as its second argument to reuse it. `PASEO_HOST_LOOPBACK_PORT` publishes the daemon on host loopback only, which the Host needs.

An installation's Dev container runs in gate mode instead: `PASEO_NETWORK_MODE=gate` puts Dev behind the [network gate](../../docs/execution-installation.md#dev-network-gate) with `compose.gate.yaml`, and `gate.sh enable` moves an existing deployment there, rolling back when Dev does not become healthy. The installer engine in `scripts/installer/` sets both up; a deployment in gate mode has a `.gate-mode` marker.

[Build, update and troubleshoot](../../docs/docker.md). [Optional workspace previews](../tailscale/README.md). Keep the deployment directory outside this checkout.
