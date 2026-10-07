# <img src="packages/app/assets/brand/vorteo-color.png" width="48" height="48" alt="Vorteo icon" /> Vorteo (Vorton + Paseo)

- [Vorton](https://github.com/AubreyF/vorton) is an elegant visual control plane for AI operating systems and software factories.
- Vorteo extends [Paseo](https://github.com/getpaseo/paseo) for seamless Vorton integration. It also adds multiple Codex accounts, usage visibility, reusable profiles, task goals, cross-device message queuing, and a smoother ux. I've used it to build massive open-source projects such as [Freed](https://freed.wtf). I'm sharing it as open source to empower other OS devs with max agentic leverage and efficiency. Let's steer the course of history, together.

## Intelligent Frontier Account Pooling

Connect multiple Codex and Claude accounts and distribute tasks across them. See usage and reset windows beside reusable profiles that keep your model, reasoning, permissions and instructions together.

<img width="800" alt="Vorteo environment and profile switcher" src="https://github.com/user-attachments/assets/b2489333-cb9a-4f2f-9d0b-8ee1c319923c" />

## Enhanced Security

- **Give agents room to work without handing them your whole machine.** The installer automatically builds and starts a local dev container for Vorteo and your agents. This limits the damage an accidental destructive command can do to your host: agents can modify the container home and mounted projects, while unmounted personal files stay outside their filesystem access. Keep backups of mounted projects; the container does not protect those files from deletion. See the [security boundaries](docs/container-tailscale.md).

<img width="400" alt="Vorteo host versus dev container permissions authorization." src="https://github.com/user-attachments/assets/2429afbe-65fb-41d5-9899-b7c7aea20d04" />

## Power Tools to Manage Your Fleet

- **Cross-device, server-managed message queuing.** Line up your task messages with files or images - then edit, reorder, pause, and send them from any connected device. The daemon in each environment will continue executing queued work even if your client is offline.

<img width="400" alt="Server managed cross-device message queuing." src="https://github.com/user-attachments/assets/59dfdb03-e1ec-40d2-b66e-9683134e3811" />

- **Automated daemon upgrades and restarts for zero downtime operations.** Once an upgrade is prepared, approve a queued restart for the Host or Dev container daemon. Vorteo waits for active agents and workers to finish, then restarts automatically, even with your browser closed.

<img width="400" alt="Queued daemon upgrades" src="https://github.com/user-attachments/assets/3a1c344d-42ac-4da7-8fb0-b5059b3c280f" />

- **Put local workers to work.** Choose a worker account and profile on each supervisor, including accounts from another provider or Pi models on local or private endpoints. Set a concurrency limit and follow each worker beneath its originating task, even when it uses a separate worktree.

<img width="400" alt="Frontier delegation to local workers" src="https://github.com/user-attachments/assets/fb255faa-8e19-4f28-8ec8-55a8b253ed2a" />

- **Give Codex a goal.** Set an objective with an optional token budget. Follow status, elapsed time and token usage, then pause or resume when you need to intervene.

<img width="400" alt="Server authoritative goal direction for the Codex integration" src="https://github.com/user-attachments/assets/ed51f89f-077f-43c3-90b6-768ad8a4538d" />

- **Enclaves for streamlined factory operations.** Mark a workspace Standing to keep it in view and protect it from accidental archival. Add custom labels and see which workspaces have scheduled tasks.

<img width="400" alt="Protected and scheduled workspaces" src="https://github.com/user-attachments/assets/757352aa-a2e7-457d-b95f-7ded601444f7" />

## Install

Give your agent this command, or run it yourself:

```sh
git clone https://github.com/AubreyF/vorteo.git "$HOME/vorteo-source" &&
  bash "$HOME/vorteo-source/docker/multiplex/install.sh" "$HOME/vorteo"
```

### Instructions for installation agents

Your task is to get the user to a working web interface.

1. Clone the repository and run the container installer above. Complete any required Tailscale login.
2. Confirm the container is running, then open the installation’s HTTPS address and verify that the web interface loads. A running container alone does not establish success. If access fails, diagnose and fix it before handing over.
3. As soon as access works, give the user the clickable HTTPS address and tell them where to find their login password. Keep the handoff short.

Provider authentication happens afterward through the provider settings, which explain any required container CLI sign-in. Do not ask the user to authenticate Codex, Claude, or other providers during installation. Do not delay the browser handoff for provider setup, presets, or optional configuration.

Keep progress messages brief. If verification requires access only the user has, request that specific check and state what remains unverified.

The installer builds locally, creates private storage and starts the container. Complete the Tailscale login, open the printed HTTPS address, and use the password in `$HOME/vorteo/.env`. Connect your provider accounts in the web interface. Connect other devices through Tailscale using the environment address and existing application authentication. QR and pairing-link onboarding are retired.

No registry account, host Node or separate host Tailscale installation is needed. Existing checkout? See [installation details](docker/multiplex/README.md).
Keep personal files, Docker's socket and other users' homes outside the container mounts. See the [security boundaries](docs/container-tailscale.md).

## Optional: your own domain with private access

Use an address such as `https://vorteo.example.com` while keeping the application accessible only through Tailscale. Give the user their working installation address first; configure a custom domain afterward when requested.

The custom-domain gateway runs separately from the application. It consists of two containers: Tailscale provides private connectivity, and Caddy provides trusted HTTPS and forwards requests to the application. They share a network namespace and publish no host ports.

**Instructions for agents:**

1. Confirm the user’s hostname, DNS provider, and intended users. Follow the [custom-domain setup guide](docs/private-domain.md) and supplied templates through an authorized operator session.
2. Preserve the existing installation and working address. Keep Tailscale Funnel disabled, retain application authentication, and configure the exact custom hostname and origin.
3. Configure automatic certificate renewal through DNS validation. Keep credentials outside Git and logs, restrict them to the required DNS zone, and provide them only to Caddy. Persist certificate and Tailscale identity storage.
4. Verify the gateway before pointing the hostname to its private Tailscale address. For Cloudflare, use **DNS only**.
5. Verify the final address from an authorized device, including login and live connectivity. Confirm access is denied outside the authorized network. Fix failures before declaring success, then give the user the clickable address.

Keep updates brief. Request only the specific user or administrator action needed to complete a blocked check. DNS records are public; access to the application remains private.

## Further Reading

- [Vorteo customizations beyond upstream Paseo](docs/vorteo-customizations.md)
- [Roadmap](docs/roadmap.md)
- [Accounts and presets](docs/agent-presets.md)
- [Development inside the container](docs/development.md)

For browser testing, the [Chromium setup and check commands](docs/development.md#chromium-in-the-development-container) support Debian 12 containers, including existing installations that need browser libraries without a restart.
