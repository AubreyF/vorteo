# <img src="packages/app/assets/brand/vorteo-color.png" width="48" height="48" alt="Vorteo icon" /> Vorteo (Vorton + Paseo)

- [Vorton](https://github.com/AubreyF/vorton) is an elegant visual control plane for AI operating systems and software factories.
- Vorteo extends [Paseo](https://github.com/getpaseo/paseo) for seamless Vorton integration. It also adds multiple Codex accounts, usage visibility, reusable profiles, task goals, cross-device message queuing, and a smoother ux. I've used it to build massive open-source projects such as [Freed](https://freed.wtf). I'm sharing it as open source to empower other OS devs with max agentic leverage and efficiency. Let's steer the course of history, together.

## Multiple accounts, one place to work

Connect your Codex and Claude accounts once and run tasks under different accounts simultaneously. Choose the account for each task without repeatedly signing out and back in. Keep work moving across accounts while seeing which account each profile uses and when its usage limits reset.

For Claude, open **Settings → Providers → Add provider → Claude Code (Claude account)**. Name the account, start sign-in, open the official Claude sign-in page, and paste its return code into the account panel. The official CLI runs inside the container and stores each account separately. Accounts suggest names such as **Claude 1** and **Claude 2**, and support reconnect, rename, disable and removal. New container images include Claude Code; existing installations need an updated daemon and the CLI installed inside the container.

Claude availability checks the CLI sign-in status. Each account uses its own credentials, usage, session history and model settings. Removing an account preserves shared and external credential directories.

See the [account connector roadmap](docs/roadmap.md#account-connectors) for account naming behavior and connector acceptance status.

On hosts with shared provider preferences, accounts share model defaults, reasoning choices and workflows by provider type. Choose a model and reasoning level independently of a workflow, then switch accounts without rebuilding that configuration. Workflows retain intentional differences such as permissions, instructions and local worker teams. These settings live on the host and follow you across devices. Installation controls in General settings provides owner review of restarts and shared workflows. The host installer generates its separate owner password during setup; saved daemon connections continue to work when those controls are locked. Older hosts retain account-specific profiles. The protected host and container installation also shares these workflows through its coordinator. Migrated workflow references keep their original environment behavior, and legacy worker teams resolve to local accounts.

Host workspace titles in the sidebar begin with a golden host and key icon. Host and container labels no longer add an environment subtitle, and the composer selector leaves clear space between its environment icon and preset name. The account picker groups workflows under each account in compact, equal-height rows, without row dividers, with a larger selection check on the left. Search and **Manage profiles** share rounded corners and compact desktop sizing while retaining full touch targets. Desktop uses a split pane; mobile slides into the selected account’s details with a back button to return to connections. The mobile list scrolls with the sheet. **Use profile** stays at the bottom of the details pane. Pi’s details list its discovered models with reasoning support, reported context and output limits, and supported inputs. Local connections also show endpoint and worker status in the account list. Search stays beside **Manage profiles**, which opens **Profiles** in provider settings. On capable hosts, the editor applies to all accounts of that provider type. Shared permissions apply to new chats. Existing chats keep their permissions and show a warning with a recreate action when the saved profile differs.

<img width="600" alt="Animated demo of Vorteo account switching and profiles" src="https://github.com/user-attachments/assets/ae3f9872-f3d6-4efa-8f23-a032aa3133de" />

_Account switching and profiles in action._

For an existing task, changing profiles opens a handoff you can review and edit before starting a successor task. The handoff body scrolls beneath the title, including the instructions, editable context and action buttons. The original stays available. This transfers selected conversation context, not the provider's entire session history.

## More control over your agents

- **Give agents room to work without handing them your whole machine.** The installer automatically builds and starts a local container for Vorteo and your agents. This limits the damage an accidental destructive command can do to your host: agents can modify the container home and mounted projects, while unmounted personal files stay outside their filesystem access. Keep backups of mounted projects; the container does not protect those files from deletion. See the [security boundaries](docs/container-tailscale.md).
- **See your available capacity.** Check account usage and reset times beside your profiles. Use existing reset credits where the provider supports them.
- **Give Codex a goal.** Set an objective with an optional token budget. Follow progress, elapsed time and token usage from the goal bar, and pause or resume when you need to intervene.
- **Line up the next steps.** Queue messages with files or images, then edit, reorder, pause or send them from another connected device. The host owns the queue and can keep delivering messages after you close the client. Pausing the queue leaves an active goal eligible to continue; stopping the task pauses both. Saved queues do not guarantee uninterrupted execution of an active turn during a host restart. Queue, goal and subagent cards scroll with the conversation. Collapse the Subagents card using its heading; the count and Archive finished action stay visible. Unsaved queue edits stay on the device across reloads, including newly added images. Save synchronizes text and attachment changes; Cancel leaves the shared message unchanged. Drag queued messages to reorder them; sidebar badges show queued messages, subagents and active goals.
- **Put local workers to work.** Configure a Pi profile for a local or private OpenAI-compatible endpoint, then let a supervisor delegate work with a limit on concurrent workers.
- **Keep projects in view.** In Vorteo mode, History and Schedules sit in the top sidebar toolbar. The three-dot menu holds Settings, Add project, New workspace, View preferences, and Help and support. In View preferences → Show, turn Activity badges on or off to show or hide subagent counts, queued-message counts, and active-goal badges. On mobile, the compact search field keeps a full-height tap target. iPhone toolbars use the system safe area. On iOS 27 Home Screen apps, Vorteo also keeps toolbar controls below the system status-bar blur. This clearance applies once per toolbar and disappears in landscape when the top safe area is zero; Safari tabs and Standard mode retain their existing spacing.
- **Continue in another project.** In Vorteo mode on web and desktop, drag a workspace onto another project to recreate one selected chat there. Choose the destination environment and profile, then review and edit the handoff before starting. Workspaces with other chats show a warning and recommend cancelling. The original remains available. Files, Git changes, other chats, attachments and tool results are not copied.
- **Work from your phone or tablet.** Compact profiles, visible touch controls and responsive task views keep account selection and task management within reach. Sidebar rows and actions expand into larger touch targets on touchscreens and in narrow windows. The workspace diff counter keeps a 44-pixel touch target in compact layouts. On desktop, hover a project or workspace row to reveal its three-dot menu.

Archiving a workspace also archives its threads. When the selected workspace is archived, including through an agent or another client, you return to an empty New workspace page for the same project.

Open **Settings → General → What's new** to see Vorteo additions alongside Paseo release notes. Vorteo mode includes bundled custom history, available even when the upstream feed cannot be reached.

## Plugins

Add themes, workspace panels, commands, settings screens, and coding-agent providers with trusted
TypeScript plugins. Install from npm, Git, or a local directory with `paseo plugin install <source>`.

Vorteo’s selected launch settings, profile instructions, reserve policy, and configured account environment take precedence over plugin launch hooks. Hooks can supply defaults and additional environment variables.

Start with the [plugin quickstart](https://paseo.sh/docs/plugins). Plugins run with access to your daemon
machine and inside connected clients; install only code you trust.

## Updates

Settings → General includes app information and update controls. In Vorteo mode, **Paseo upstream updates** shows the last upstream merge included in this interface and highlights it after a week. The optional [host and container installation](docs/execution-installation.md) adds **Prepare host update task** and **Prepare host merge task**: review and edit a host-targeted message before manually sending it. Instance restarts require your approval.

The protected installation shares agent workflows, provider defaults, and preferred model and reasoning choices between execution environments. Credentials and provider availability stay local. Offline edits are retained, and conflicting edits can be reviewed in Installation controls.

The environment selector and profile dropdown use a teal cube for Dev container and an amber monitor with a key for Host access.

The macOS host extension is prepared in source and requires installation and acceptance on the host. It keeps the existing Docker container and adds a native daemon with full owner-account access, a protected shared interface, and owner-approved restart requests. The shared interface accepts environment addresses with standard HTTPS or custom ports. The protected interface can use an owner-managed HTTPS domain. Previous installation addresses can redirect to it while keeping conversation and project links. Once both connections are saved, reload opens your work without repeating setup; installation controls remember owner access for seven days per browser, with explicit locking and separate approval of each restart. Trusted host agents can create container workers in an existing workspace, including its selected worktree. It does not replace Docker with Apple Container. See the [setup and trust boundaries](docs/execution-installation.md).

## Install

The Vorteo signature is used in both interface modes, startup screens, browser tabs, Safari pinned tabs and installed app icons.

The product is now named Vorteo. Existing `paseo` commands, `PASEO_*` environment variables, package names, configuration paths and deep links remain unchanged.

Use the [host folder sharing workflow](docs/docker.md#share-host-project-folders) to make existing projects accessible to the container. Hosts with folder browsing support list shared folders separately from container storage in **Add project**, with the same selection flow for new directories and clone destinations. Older hosts accept container paths; typed paths remain selectable while search suggestions load.

Install Git and start Docker with Compose. Install Tailscale on the devices you will connect from.

Give your agent this command, or run it yourself:

```sh
git clone https://github.com/AubreyF/vorteo.git "$HOME/paseo-source" &&
  bash "$HOME/paseo-source/docker/multiplex/install.sh" "$HOME/paseo-instance"
```

### Instructions for installation agents

Your task is to get the user to a working web interface.

1. Clone the repository and run the container installer above. Complete any required Tailscale login.
2. Confirm the container is running, then open the installation’s HTTPS address and verify that the web interface loads. A running container alone does not establish success. If access fails, diagnose and fix it before handing over.
3. As soon as access works, give the user the clickable HTTPS address and tell them where to find their login password. Keep the handoff short.

Provider authentication happens afterward through the provider settings, which explain any required container CLI sign-in. Do not ask the user to authenticate Codex, Claude, or other providers during installation. Do not delay the browser handoff for provider setup, presets, or optional configuration.

Keep progress messages brief. If verification requires access only the user has, request that specific check and state what remains unverified.

The installer builds locally, creates private storage and starts the container. Complete the Tailscale login, open the printed HTTPS address, and use the password in `$HOME/paseo-instance/.env`. Connect your provider accounts in the web interface. Vorteo mode is enabled by default on a fresh installation.

No registry account, host Node or separate host Tailscale installation is needed. Existing checkout? See [installation details](docker/multiplex/README.md).

## Optional: your own domain with private access

Use an address such as `https://paseo.example.com` while keeping the application accessible only through Tailscale. Give the user their working installation address first; configure a custom domain afterward when requested.

The custom-domain gateway runs separately from the application. It consists of two containers: Tailscale provides private connectivity, and Caddy provides trusted HTTPS and forwards requests to the application. They share a network namespace and publish no host ports.

**Instructions for agents:**

1. Confirm the user’s hostname, DNS provider, and intended users. Follow the [custom-domain setup guide](docs/private-domain.md) and supplied templates through an authorized operator session.
2. Preserve the existing installation and working address. Keep Tailscale Funnel disabled, retain application authentication, and configure the exact custom hostname and origin.
3. Configure automatic certificate renewal through DNS validation. Keep credentials outside Git and logs, restrict them to the required DNS zone, and provide them only to Caddy. Persist certificate and Tailscale identity storage.
4. Verify the gateway before pointing the hostname to its private Tailscale address. For Cloudflare, use **DNS only**.
5. Verify the final address from an authorized device, including login and live connectivity. Confirm access is denied outside the authorized network. Fix failures before declaring success, then give the user the clickable address.

Keep updates brief. Request only the specific user or administrator action needed to complete a blocked check. DNS records are public; access to the application remains private.

## Work and contribute

Keep personal files, Docker's socket and other users' homes outside the container mounts. See the [security boundaries](docs/container-tailscale.md).

- [Accounts and presets](docs/agent-presets.md)
- [Development inside the container](docs/development.md)
- [Updates and troubleshooting](docs/docker.md)
- [Optional private workspace previews](docker/tailscale/README.md) reuse the task workspace, configured service and private HTTPS reservation. The host can admit registered projects and worktrees without individual grants while retaining host path verification. With matching daemon and web updates installed, Vorteo workspace hover cards include clickable globe rows for running previews, using the broker private HTTPS address.
- [Team handoff and testing](docs/host-handoff.md)
- [Planned work](docs/roadmap.md)

This is an experimental fork of [Paseo](https://github.com/getpaseo/paseo). Source capabilities and deployed acceptance are tracked separately. Keep credentials, deployment state and test receipts outside Git.
