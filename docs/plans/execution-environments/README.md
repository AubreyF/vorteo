# One installation, two execution environments

Status: implementation authorized October 2, 2026. Target six hours where feasible; the two-day scope and acceptance boundary remain the baseline. No installation or acceptance is claimed by this document.

## First release

Deliver one Vorteo installation and one trusted interface that controls the existing development container and a native host daemon. Target two working days for the owner's existing macOS installation. This is a scoped engineering estimate, not verified completion or a guarantee for every installation topology.

One installation does not mean one process. Use two ordinary Paseo daemons, each owning its agents, terminals, Git operations, files, scripts, state, and authentication. The installation setup registers both environments in the existing client. Users should not configure two unrelated products or switch between two applications.

Keep the existing Docker container. Do not introduce Apple Container, replace Docker Desktop, recreate production, or build a generalized execution RPC in this release. A native full-access agent is trusted with the host account, including its accessible credentials and Docker authority. It is not a selectively confined agent and does not automatically gain root or bypass macOS permissions.

## User experience

New Workspace offers an execution choice: **Dev container** or **Host: full account access**. Retain **Local directory** and **New worktree** as a separate checkout choice. A worktree is code isolation, not a security boundary.

Default new unassigned work to the dev container. Host selection is explicit and remains visible in workspace and terminal context. Confirm the first host activation in the trusted owner interface. Do not silently fall back from an unavailable container to the host. Existing workspaces retain their owning daemon and histories; switching environments creates a new workspace rather than moving a live session.

Use one sidebar project for matching repositories across environments, with the environment chosen per workspace. Keep project placement records and execution state scoped to their owning daemon. The handoff dialog can register a destination project and create a workspace there. Paths are explicitly selected and resolved by the destination daemon. Provider authentication remains local to each daemon; do not copy all container credentials to the host. Existing host credentials may be used only through the provider's normal configuration.

## Installation and trust boundary

The installation entry point owns setup, status, and removal of its new host component. It registers the existing container as an attached component, preserving its identity and independently managed lifecycle. A small host-owned installation record tracks the two server identities, endpoints, and lifecycle ownership. Reuse existing connection offers and client registration; secrets must not appear in URLs, logs, or the container's filesystem.

Serve the shared web interface from an installed host release outside every guest mount, or use a trusted installed client. The client connects separately to the two authenticated daemon endpoints. This avoids implementing a privileged command proxy through the container. Reuse existing private HTTPS transport for the supported machine, with explicit origin admission. One interface can use two endpoints; one public network listener is not an acceptance requirement.

Host runtime files, configuration, authentication state, launch definitions, and web assets must all live outside guest-writable directories. Never execute the host service directly from the shared development checkout. Install a reviewed build as a separate release. The owner-account host agents can still modify owner-accessible files; this boundary protects against the guest, not against trusted host agents.

Keep host connection credentials out of the old container-served web origin. Do not embed that application as privileged UI. Render container responses as untrusted data and audit client-side command handling for cross-environment effects. A compromised guest must not be able to invoke host operations through the trusted client.

For the first release, deny guest-initiated browser automation in any client session that holds host authority. Enforce that at the trusted client, not through a guest-controlled preference. Prefer disabling this bridge to building browser profile isolation under the deadline. Reject container-supplied client plugin bundles too: they execute JavaScript with the client's full authority. Only the configured trusted native host may supply these bundles. Rich browser automation across trust levels is a separate project. Existing grants and mount access are not undone by adding this boundary.

No Docker socket, host RPC credential, lifecycle control socket, or host-wide shell endpoint enters the guest. Merely omitting Docker's socket is insufficient if the guest can rewrite the host service or steer an authenticated browser.

## Reuse and engineering boundaries

Inspected source already has server-scoped connections and sessions in `packages/app/src/runtime/host-runtime.ts` and `packages/app/src/stores/session-store.ts`. `packages/app/src/screens/new-workspace-screen.tsx` already carries a selected server separately from local/worktree isolation. `packages/cli/src/utils/daemon-target.ts` supports explicit instance-home targeting. The default installer remains container-only. The optional host extension now has a separate [source entry point and operating guide](../../execution-installation.md); host installation and acceptance remain pending.

Preserve daemon IDs and scope client caches, drafts, outbox messages, provider choices, and workspace operations to their owning server. Reuse existing protocol messages. If environment metadata needs wire fields, make them optional and capability-gated according to the compatibility docs. Do not create a universal runtime abstraction for two known existing daemons.

The shared installation record is lifecycle metadata, not an authorization grant. Each daemon continues to authenticate its clients independently. A future credential broker must not infer task authority from a display label or this record.

## Two-day execution plan

Budget approximately 12 to 16 focused engineering hours, including acceptance on the existing Mac. Universal unattended installation, other operating systems, and unexpected macOS permission or private-network changes are outside this estimate.

1. First two hours: verify current host state, source version, client registration, private transport, and browser-command rejection. Freeze exact supported setup. If the protected client cannot safely hold both connections without a larger redesign, report that blocker immediately rather than substituting two disconnected installs.
2. Remainder of day one: add host component setup/status/removal, protected release and separate state, managed native startup, two-environment registration, and explicit execution labels. Exercise an agent and terminal in each environment from the same interface.
3. Day two: test phone and workstation use, reconnect and queued-message routing, unauthorized access, startup and rollback. Complete focused tests, required typecheck/lint, build and publication checks, documentation, and host acceptance.

The scope can shrink by deferring visual polish and automated onboarding for unfamiliar networks. It cannot shrink by omitting authentication, guest-to-host rejection, clear execution identity, or rollback. Do not claim the two-day release is complete if those checks fail.

## Acceptance and rollback

- One installation setup registers both environments and produces one trusted entry point. No manual second-daemon configuration is required for the supported setup.
- A phone and workstation can create, steer, stop, and reconnect to agents in either environment from that interface.
- Files, terminals, Git, and scripts execute in the selected environment. Reconnects and delayed messages never change the target.
- Unauthenticated and container-only credentials cannot execute host work. The guest cannot read host credentials, replace host runtime/UI files, or operate the privileged browser bridge.
- Stopping the new host component leaves container agents and existing routes running. Stopping the container never redirects its work to the host.
- Host startup uses its own state and an unoccupied endpoint. Service-context macOS folder permissions are tested, not inferred from an interactive shell.
- Rollback removes only the new host service, its owned route, and registration. Preserve its state for recovery. Do not restart Docker Desktop, the primary daemon, or unrelated services.
- Source integration, remote publication, installed release, and real-device acceptance are recorded separately. Runtime receipts and machine paths stay outside Git.

Existing repository policy prohibits native host installation. The requested architecture deliberately changes that policy for the opted-in trusted host component. The implementation must amend the owning policy and installer documentation consistently; this proposal does not silently change current rules or authorize interruption of running work. Host work follows the existing continuity workflow.

The diagnostic report found the primary runtime depends on nonpersistent release paths. Do not recreate it to deliver this feature. Detailed machine findings remain in the private report, outside Git. The observed folder mapping repair is already deployed; do not reimplement it as part of this release.

## Independent future projects

Each linked document owns a separately deliverable project with its own acceptance criteria. Dependencies are stated explicitly; independent delivery does not mean every project has zero dependencies. None blocks the two-day release except the minimum trust boundary above.

| Project                                                        | Outcome                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Task containers through Docker](docker-task-containers.md)    | Create and supervise isolated task environments using the Docker installation already available |
| [Apple Container backend](apple-container.md)                  | Optional macOS backend for new Linux task containers                                            |
| [Host directory grants](directory-grants.md)                   | Browse and share folders without manual Docker commands                                         |
| [Environment and task grants](environment-grants.md)           | Host-issued identities and bounded operations for lower-trust environments                      |
| [Credential broker and GitHub connector](credential-broker.md) | Protected credentials and typed, approved GitHub operations                                     |
| [Native Freed installations](freed-native.md)                  | Concurrent macOS installations with separate data and authority                                 |
| [Linux Freed soak testing](freed-linux.md)                     | Reproducible headless soak runs with bounded resources                                          |
| [Browser trust separation](browser-trust.md)                   | Safely restore browser automation across environments                                           |
| [Primary installation recovery](installation-recovery.md)      | Reconstructible releases and separately planned migration                                       |
| [Transparent HTTPS mediation](https-mediation.md)              | Research compatibility and security before adding transparent credential injection              |
| [Browser credential mediation](browser-credentials.md)         | Define which browser-authenticated actions can be safely delegated                              |
| [Provider authentication migration](provider-auth.md)          | Assess credential isolation across provider CLIs independently                                  |
| [Kernel information-flow research](information-flow.md)        | Evaluate whether stronger tracking justifies its cost                                           |
| [macOS VM testing](macos-vms.md)                               | Optional disposable native OS testing when a concrete requirement exists                        |

The earlier 10 to 16 engineering-day estimate covered a compressed combined pilot with isolated runtime and GitHub brokering. The credential-planning review recommends 16 to 25 days for that broader integrated effort. Neither estimate applies to this narrowly scoped two-daemon release, and they should not be added to the individual project estimates without removing shared work.

## Accepted implementation additions

- Agent communication is directional. Container agents can address agents in their own daemon only. Trusted host orchestrators can explicitly inspect and manage container agents using host-held credentials. Container output is untrusted task data, never an automatic host command or approval. Agent identity is qualified by environment; provider-native children stay in their parent's environment.
- A separate installation coordinator survives either daemon restarting. Agents can submit bounded restart requests; the owner approves the exact target and request revision in the protected interface. Requests expire and are not replayed after an ambiguous coordinator crash. Verify replacement identity and health, and retain durable outcomes. Host agents remain owner-account trusted. Do not grant container agents host restart credentials.
- Provide an installation maintenance skill in both environments. It describes request, owner approval, disruption, readiness, and rollback. A request is not permission to restart. The current work must not restart primary services merely to exercise this feature.
- Administrative actions for local Vorteo updates and upstream merges open editable host-targeted task drafts. The owner reviews and manually sends them. Never dispatch an agent or merge code merely because an update action was clicked; deployment restarts use the separate approval flow.
