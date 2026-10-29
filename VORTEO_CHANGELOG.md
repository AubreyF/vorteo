# Vorteo changelog

Vorteo change history, covering features, fixes, documentation, tests, tooling and upstream integration. Update this file in every commit using the prepared version and a dated entry. See the [commit workflow](docs/release.md#vorteo-release-notes).

The initial baseline is cumulative; older entries do not cover every maintenance commit. Historical version labels are preserved. Paseo release history remains in the [upstream changelog](CHANGELOG.md); the [customizations inventory](docs/vorteo-customizations.md) describes current fork capabilities and limitations.

## 0.11.0-beta.3.vorteo.920 - 2026-10-29

### Maintenance

- Integrate reviewed core-services lifecycle and scratch-safety corrections while preserving local installation access and provider-history recovery.

## 0.11.0-beta.3.vorteo.919 - 2026-10-29

### Fixed

- An automatic idle release now blocks new runs with a closing marker that a Stop or a replacement's cancellation cannot clear. Direct prompts, replacements, queued delivery and rewind stay refused until the provider close settles, even after the run reservation's cancellation deadline passes.
- The Dev scratch reaper takes a fresh process snapshot for every deletion and keeps the candidate when that snapshot is incomplete or the process table is missing; read failures are reported, never treated as unused files.
- The reaper's unpushed-work check covers every local ref, including notes and custom refs, not only HEAD, branches and tags.

### Maintenance

- The core-services plan labels the pre-cutover Vorton description as history.

## 0.11.0-beta.3.vorteo.918 - 2026-10-29

### Fixed

- Automatic idle release reserves the agent in the same synchronous step as its final check, so a prompt or queued delivery cannot start a turn while the provider closes; a refused queue item is delivered after the agent reopens. Durably hosted sessions keep the atomic host close.
- Idle release passes the observed update time and session to the manager, which refuses an agent that changed after the sample, so a candidate that worked again during an earlier release keeps its full idle period.
- The session host reuses its private tool bridge only when it is a regular file with exactly the shipped bytes; a modified copy or a link is replaced atomically without following the link.
- The Dev scratch reaper inspects every Git repository inside an entry, including stashes and all local branches and tags, keeps bare repositories and unreadable subtrees, refuses deletion without full process visibility, rechecks each entry before removing it and reports failed removals.
- The hosted app tool verifies the pinned Node executable before running build commands and records the verified identity.

### Maintenance

- The core-services plan separates source, owner-reported live and pending status, drops the obsolete gateway identity migration and defers lab setup to the lab installation guide.

## 0.11.0-beta.3.vorteo.917 - 2026-10-29

### Added

- Native custom-domain gateway: runs Caddy and a dedicated userspace Tailscale node as Host login jobs with digest-verified binaries, keeps the DNS token out of arguments and job files, and can hold requests while a loopback upstream restarts. The guide switches from the Docker gateway by running the native gateway as its own node and moving DNS.
- Hosted app tool for trusted web applications: builds a release from one reviewed commit, keeps live state in a Host-owned instance that deploys never overwrite, imports only the live entries of scratch-heavy folders, and stages a login job that refuses to start without a deployed release and imported state.
- Dev scratch reaper: reports stale container scratch, keeping anything recently modified, used by a process (including running executables and mapped libraries) or holding uncommitted or unpushed Git work; deletion requires `--delete` and full process visibility.

### Fixed

- Idle agents release their provider process, such as a Codex app-server, after 30 idle, unchanged minutes and reopen on demand; durably hosted sessions use the atomic idle close. Timeline reads had kept one process per agent read.
- Daemon shutdown closes each WebSocket as a server shutdown and drops a peer that ignores the close within one second; clients retry every 500 ms for a minute after such a close.
- The session host runs its tool bridge from a pinned private copy, so release cleanup cannot remove it from under long-running hosted sessions.
- The preview broker and helper accept a daemon whose executable was replaced with identical bytes, and still refuse any other replacement.

### Maintenance

- Plan for core services on the Host, with findings, phases, release channels, a lab installation and the invisible-restarts design. Multiple containers and other platforms are documented for discussion only.
- Merge current `main` into the core-services branch for integration.
