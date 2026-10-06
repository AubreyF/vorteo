# <img src="packages/app/assets/brand/vorteo-color.png" width="48" height="48" alt="Vorteo icon" /> Vorteo (Vorton + Paseo)

- [Vorton](https://github.com/AubreyF/vorton) is an elegant visual control plane for AI operating systems and software factories.
- Vorteo extends [Paseo](https://github.com/getpaseo/paseo) for seamless Vorton integration. It also adds multiple Codex accounts, usage visibility, reusable profiles, task goals, cross-device message queuing, and a smoother ux. I've used it to build massive open-source projects such as [Freed](https://freed.wtf). I'm sharing it as open source to empower other OS devs with max agentic leverage and efficiency. Let's steer the course of history, together.

## Intelligent Frontier Account Pooling

Connect an unlimited number of Codex and Claude accounts, then balance tasks across all of them simultaneously. Keep work moving while tracking usage and reset windows for each connected profile. Drafts restore their saved account and workflow together. New drafts use a workflow from the selected account. Drag providers in Settings to set their order in the profile picker. Delete custom providers, including Antigravity and Muse Code, from the same list.

<img width="600" alt="Animated demo of Vorteo account switching and profiles" src="https://github.com/user-attachments/assets/ae3f9872-f3d6-4efa-8f23-a032aa3133de" />

When an older Claude Code version hides newer models, Vorteo shows an update warning in provider settings and the account and model pickers. It lists the installed version, affected models and update instructions for the selected environment. Update the CLI and refresh the provider to clear the warning.

## Enhanced Security

- **Give agents room to work without handing them your whole machine.** The installer automatically builds and starts a local dev container for Vorteo and your agents. This limits the damage an accidental destructive command can do to your host: agents can modify the container home and mounted projects, while unmounted personal files stay outside their filesystem access. Keep backups of mounted projects; the container does not protect those files from deletion. See the [security boundaries](docs/container-tailscale.md).

<img width="400" alt="Vorteo host versus dev container permissions authorization." src="https://github.com/user-attachments/assets/2429afbe-65fb-41d5-9899-b7c7aea20d04" />

## Power Tools to Manage Your Fleet

- **Manage skills across environments.** Open **Settings > Skills** to inspect installed skills, instructions, ownership and hashes across environments. Shared provider paths appear once per environment, with each path available in Details. Preview pinned installations, provider discovery links, identical-copy consolidation, removal and restoration. Profiles can inherit defaults with exclusions, select specific skills or disable optional skills on supported providers. See the [skill library guide](docs/skill-library.md).

- **Give Codex a goal.** Set an objective with an optional token budget. Follow progress, elapsed time and token usage from the goal bar, and pause or resume when you need to intervene.

<img width="400" alt="Server authoritative goal direction for the Codex integration" src="https://github.com/user-attachments/assets/ed51f89f-077f-43c3-90b6-768ad8a4538d" />

- **Line up the next steps.** Queue messages with files or images, then edit, reorder, pause or send them from another connected device. The host owns the queue and can keep delivering messages after you close the client. Pausing the queue leaves an active goal eligible to continue; stopping the task pauses both. Saved queues do not guarantee uninterrupted execution of an active turn during a host restart. Question, approval, plan, queue, goal and subagent cards share a subtle border, compact corners and consistent spacing above the message box and scroll with the conversation. Card headings match the row height, including the Subagents accordion hover. Collapse the Subagents card using its heading; the count and Archive finished action stay visible. Messages waiting to synchronize use the same queue rows, with a warning icon whose tooltip says “Queued on this device.” Unsaved queue edits stay on the device across reloads, including newly added images. Save synchronizes text and attachment changes; Cancel leaves the shared message unchanged. Drag queued messages to reorder them; sidebar badges show queued messages, subagents and active goals.

- **Put local workers to work.** Configure a Pi profile for a local or private OpenAI-compatible endpoint, then let a supervisor delegate work with a limit on concurrent workers.

- **Keep projects in view.** In Vorteo mode, Search sits at the left of the top sidebar toolbar, with its configured shortcuts in the tooltip. On Mac, Cmd+K and Opt+Space both open Search; Windows and Linux use Ctrl+K. The three-dot menu, History, Schedules, and Settings stay visible at the right, in that order. Usage stays out of the sidebar, and app preferences omit the Sidebar section. The settings Back button uses a compact outline style. The three-dot menu holds Add project, New workspace, View preferences, and Help and support. In View preferences → Show, turn Activity badges on or off to show or hide subagent counts, queued-message counts, and active-goal badges. On mobile, the Search icon keeps a full-height tap target. iPhone toolbars use the system safe area without extra clearance. Vorteo uses a fixed background hint to suppress the native top blur in iOS Home Screen apps. Shortcuts originally installed with a translucent status bar retain that setting after updates. Add a replacement from Safari and verify it before removing the old shortcut; see [Home Screen troubleshooting](docs/ios-home-screen.md).

- **Seamlessly transition between phone, tablet, and desktop.** Choose an environment, account and saved profile in the profile switcher’s three desktop cards or collapsible mobile sections. New workspace uses this switcher for Host and Dev container selection. Profile rows show their saved model and reasoning; choosing one keeps those settings together. Host appears first with its access risk explained; selections use orange outlines. The closed chooser shows the selected profile. Activate Profile appears after an initial selection, and Switch to Profile appears when changing the active environment, account or profile. The action slides below the scrolling profile card and collapses completely when hidden. The chooser opens immediately while account usage and other data load inside it. Environment, account and profile tiles share a two-line layout and height. Account tiles show remaining usage at the upper right, with reset timing and credits on the second line. Wide layouts show a two-column profile grid and indented permission and worker details. Mobile profile management remains in Settings. Choose any environment’s profile to continue a chat in the same project. Projects can contain workspaces from different environments and repositories. The handoff keeps the project selected and resolves a working directory in the chosen environment. Visible touch controls and responsive task views keep task management within reach. Sidebar rows and actions expand into larger touch targets on touchscreens and in narrow windows. The workspace diff counter keeps a 44-pixel touch target in compact layouts. On desktop, hover a project or workspace row to reveal its three-dot menu.

- **Move workspaces between projects.** Choose **Move to project** from a workspace’s menu, or drag it onto a project on web and desktop. All its chats move together, preserving their history, environment and working directory. Updated daemons are required.

- **Read custom release notes.** Open **Settings → General → What's new** for Vorteo and Paseo notes in one timeline, newest first, with a shared Show more control. Vorteo version counters continue across upstream Paseo updates. Custom notes remain available when the upstream feed cannot be reached.

- **Keep your place in long conversations.** Web and desktop timelines preserve the surrounding text while image sizes settle as you scroll through earlier messages.

- **Track usage across coding tools.** Updated builds include Paseo's plugin usage sources and pinned usage windows alongside Vorteo's account and reserve controls.

Host installation restarts validate the configured supervisor and persisted settings before dispatch. Failure details stay in Installation settings. Use the same complete release for the service and its validation entrypoint. See [restart and recovery](docs/execution-installation.md#restart-and-recovery).

Installation controls sit directly in General settings. Maintenance tasks link directly to the exact request; opening the link never approves a restart. See the latest Host and Dev container restart states, review and approve requests inline, and expand history or shared workflows without opening a modal. Up and down chevrons show which installation sections are expanded or collapsed. Use the separate owner password generated by the host installer; owner access lasts seven days per browser and can be locked explicitly. Restart requests do not expire. A persistent sidebar banner shows requested and queued restarts, their reason and requester. Approve **Restart when idle** to wait for the listed active tasks to finish; the queue shows elapsed waiting time and can be cancelled before dispatch. It runs even with the browser closed. Completed and rejected requests stay in collapsed history. Each restart still requires approval, and saved daemon connections work while owner controls are locked. Owner session persistence supports Windows as well as POSIX hosts. The environment selector and profile dropdown use a green box for Dev container and an amber monitor with a key for Host access.

- **Download files you cannot preview.** In Vorteo mode, binary file previews offer a visible Download button, including files opened from chat links.

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

The installer builds locally, creates private storage and starts the container. Complete the Tailscale login, open the printed HTTPS address, and use the password in `$HOME/vorteo/.env`. Connect your provider accounts in the web interface. Vorteo mode is enabled by default on a fresh installation.

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

- [Roadmap](docs/roadmap.md)
- [Accounts and presets](docs/agent-presets.md)
- [Development inside the container](docs/development.md)

For browser testing, the [Chromium setup and check commands](docs/development.md#chromium-in-the-development-container) support Debian 12 containers, including existing installations that need browser libraries without a restart.
