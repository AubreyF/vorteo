# Signed-in browser profiles per workspace

Status: deferred future project. The owner reviewed this design on 2026-10-21 and chose to defer it; nothing here is implemented. The shipped headless browser stays empty and signed out.

Host agents can use named, persistent, signed-in browser profiles that the owner creates and grants to specific workspaces. Every other workspace keeps the empty, signed-out headless browser described in [Browser tools for Host agents](../../execution-installation.md#browser-tools-for-host-agents). The owner's everyday Chrome and any existing personal browser profile are never read, imported or attached.

## What the code does today

Verified on `main` at `37928e1ab`:

- The Host daemon registers one embedded browser host (`embedded-headless-host.ts`) when `daemon.browserTools.headlessHost.enabled` is set. A supervisor forks one browser process on demand and talks to it over zod-validated IPC.
- That process runs one Chromium with one ephemeral in-memory context. Tabs carry the requesting `workspaceId`; requests for another workspace's tab are refused. Popups join the opener's workspace.
- Every request goes through the filtering proxy in that process. It refuses private, loopback, CGNAT, tailnet and local names after DNS resolution, plus `deniedOrigins`.
- The agent never supplies `workspaceId`. `tools.ts` takes it from the calling agent's record, so an agent cannot claim another workspace. Grants can rely on this.
- Playwright's Chromium starts with `--use-mock-keychain`. A persistent Chromium user data directory would therefore store cookies under a fixed, publicly known key. That rules out a plain persistent profile directory.
- Daemon sessions record whether they were admitted with the local credential (the one `paseo` CLI and Host agents can use) or with owner authentication.

## Security boundary

Host agents run as the owner's macOS account with full account access. Anything the Host daemon can read or decrypt, a Host agent in any workspace can also reach with its shell if it deliberately tries: the profile files, the encryption key in the login keychain, the daemon's configuration. Workspace grants therefore do these things:

- Stop browser tools in an ungranted workspace from ever loading the profile, its tabs, cookies or storage.
- Stop well-behaved agents and prompt-injected agents, whose leverage is the browser tools, from crossing workspaces.
- Keep profiles completely out of the Dev container, which is a hard boundary.

They do not stop a Host agent in an ungranted workspace that sets out to steal the files with its shell. A hard boundary against other Host agents needs the browser host to run as a separate macOS user that owns the profile store. That is proposed as an optional later step (step 6), not part of the first release. The Settings copy and docs must say this plainly, alongside the warning that a grant hands those logins to every agent in the workspace.

## Relation to other projects

- [Browser trust separation](browser-trust.md) covers per-daemon profile separation for the desktop app's shared browser. This project adds owner-granted signed-in state to the Host headless browser and does not depend on it.
- [Browser credential mediation](browser-credentials.md) is the stricter alternative: bounded operations without handing agents a reusable session. Prefer it when a workflow cannot tolerate agents holding the cookies.

## Proposed design

### 1. Storage

- Location: `$PASEO_HOME/browser-profiles/` in the Host daemon's state directory, never inside a release directory, a worktree, Git, or any guest-writable mount. Directory mode `0700`, files `0600`. Step 1 verifies the actual container mounts do not expose it.
- Format: one Playwright `storageState` per profile (cookies, localStorage and IndexedDB, which Playwright 1.58 supports), encrypted with AES-256-GCM into `<profile-id>.state.enc`. Writes are atomic (temporary file, then rename). Profile metadata and grants live in `profiles.json` beside it.
- Why not a Chromium user data directory: with the mock keychain its cookies are effectively plaintext, and its plaintext sits on disk while running. With `storageState`, plaintext exists only in the browser process's memory.
- Key: one random 256-bit key in the macOS login keychain, created on first use. This keeps the key out of copies of the state directory and plain file backups. It does not stop Host agents (see the boundary above).
- Save points: when a sign-in window closes, every 60 seconds while a profile is in use and its state changed, and when the profile process stops. A crash loses at most the last interval.
- Survival: daemon restarts and release updates do not touch `$PASEO_HOME`, so profiles persist. Deleting a profile deletes its encrypted state and grants.
- Not stored: sessionStorage, HTTP cache, saved passwords, extensions and history. Sites that need those will ask the profile to sign in again.

### 2. Sign-in flow

- The owner selects **Sign in** on a profile in Settings. The Host daemon opens a visible Chromium window on the Host Mac using that profile's saved state.
- That window runs in its own browser process with the same proxy, private network refusal and denied origins. It is never registered with the browser broker, so no agent can see or drive it.
- While the window is open, agent requests for that profile are refused with a clear "being signed in" message, so two writers never race. Closing the window saves the encrypted state and reopens the profile to granted agents.
- The interface only sends the command and shows status. It never displays or drives the browser, so the protected interface still never hosts automation.
- Limitation: the owner has to be at the Host Mac, and its graphical session must be logged in. Step 1 verifies that the Host LaunchAgent can open a window. Remote sign-in from a phone is out of scope for the first release.
- Some providers, notably Google, refuse sign-in from automation-controlled browsers. Limited accounts on sites such as GitHub or staging admin panels are the expected use.

### 3. Grant model

- Grants are stored with the profiles in the Host daemon's `profiles.json`, not in shared installation settings. Profiles are Host-only by construction: the Dev daemon never holds the data, and no settings projection can carry it into the container by mistake.
- Changes go through new Host daemon RPCs (create, rename, delete, grant, revoke, start and cancel sign-in, list). Mutations refuse sessions admitted with the local credential, so `paseo` CLI calls from agents cannot grant themselves a profile. Reads for agents expose only profiles granted to their own workspace.
- Mapping: `workspaceId` (taken from the calling agent, as today) to a set of granted profile IDs. Grants name Host workspaces only.
- Selection: explicit. `browser_new_tab` gains an optional `profile` argument. Without it, the agent gets the empty signed-out browser, as today. A new `browser_list_profiles` tool lists the profiles granted to the agent's workspace. Making the signed-in session opt-in per tab keeps it away from unrelated browsing in the same workspace.
- Wire compatibility: the agent tool arguments are daemon-side MCP schemas, not the shared protocol. The broker passes the selected profile to the embedded host in-process and the host adds it to its private IPC envelope, so desktop browser hosts never see it. Tab listings gain one optional `profile` field. The Host daemon advertises a `browserProfiles` feature, and Settings shows the section only when it is present. Older daemons and clients are unaffected.

### 4. Isolation

- One browser process per profile, started on first use and stopped after 10 idle minutes. The existing signed-out process stays as it is. A renderer compromise in one profile cannot reach another profile's memory, and each process decrypts only its own profile.
- Two workspaces granted the same profile share its cookies, which is what a shared grant means, but their tabs stay workspace-scoped exactly as today. Workspaces that are not both granted a profile never share a context.
- Every request for a profile tab rechecks the grant, not only `browser_new_tab`.
- Revocation closes that workspace's tabs in that profile immediately and refuses further requests. When no granted workspace still has tabs open, the profile process saves state and stops. Deleting a profile does the same for every workspace, then deletes the data.

### 5. Policy and audit

- Granted profiles keep the private network refusal, `deniedOrigins` and the global `allowedHosts` exactly as the signed-out browser does. There are no per-profile private exceptions in the first release.
- Optional later: a per-profile list of sites that top-level navigation may reach, to make it harder to carry a signed-in session somewhere else. Not in the first release; noted in step 6.
- Audit: an append-only `audit.jsonl` in the profile directory records time, profile, workspace, agent, command and destination origin. It never records full URLs, query strings, typed text or page content, since those can carry secrets. Rotated by size. Settings shows each profile's last use.

### 6. Dev container

- Host only. The embedded host and profile store run only in the Host daemon; the Dev daemon has no profile RPCs and ignores any profile configuration.
- Container agents reach only the Dev daemon's broker, and nothing routes their browser requests to Host. Tests confirm a Dev daemon advertises no `browserProfiles` feature and refuses profile arguments.
- Step 1 rechecks the container's writable mounts against the profile directory before any code ships.

### 7. Interface

- A **Browser profiles** subsection of its own, directly after **Agent tools** in the redesigned **Agent behavior** section (agreed with the Settings redesign workspace). It is Host-only and renders only when the Host advertises `browserProfiles`, rather than sitting inside the shared agent settings that apply across environments. It stays clearly separate from the desktop app's **Browser data** subsection that follows it. Its list and its sign-in, grant and revoke rows get Settings search index entries with keywords such as browser login, sign in, cookies, profiles and grant; a test fails otherwise. It lists profiles, sign-in status, granted workspaces, last use, and actions to sign in, grant, revoke and delete.
- Grant and create dialogs state plainly that agents in the granted workspace can read every cookie and stored value in the profile, and that a malicious page could try to steer them. They recommend limited accounts and say that other Host agents with shell access are not technically prevented from reaching the files.
- Recheck this placement against the Settings catalog when work resumes; the redesign may have moved since.

### 8. Delivery when resumed

Steps 1 to 5 would ship together as one Host update; nothing is useful to the owner until the sign-in window and grants both work.

1. **Verify assumptions.** Container mounts, LaunchAgent window access, Playwright `storageState` with IndexedDB, local-credential admission on the Host daemon.
2. **Profile store and engine.** Encrypted store, keychain key, profile processes, grant checks, revocation, audit. Unit tests, proxy tests and real Chromium isolation tests.
3. **Agent tools and RPCs.** `profile` argument, `browser_list_profiles`, owner-only RPCs, feature flag.
4. **Settings interface.** The section and warnings above.
5. **Docs and delivery.** Update the Host browser docs, `browser-trust.md`, Vorteo customizations, README Power Tools if warranted, and the changelog. Port the commits onto the Host installation lineage, coordinate sequencing with the installation lead, then submit one Host source update. It needs a Host daemon restart through the tracked approval workflow; the interface publishes with it.
6. **Optional later.** Separate macOS user for the browser host (hard boundary against other Host agents), per-profile site limits, remote sign-in.

Tests reuse the existing suites (`headless-host.test.ts`, `headless-host-proxy.test.ts`, `embedded-headless-host.test.ts`, `broker.test.ts`, `tools.test.ts`) and run focused, as the testing guide requires. The real Chromium checks prove that two profiles never see each other's cookies, an ungranted workspace cannot open or address a profile tab, and refused destinations stay refused in a profile.
