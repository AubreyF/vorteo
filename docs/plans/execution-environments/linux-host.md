# Linux Host for the execution installation

Status: proposed October 18, 2026. The first slice adds inert source adapters that nothing selects yet. No Linux installation, coordinator, provisioning or acceptance is claimed. [Host and container execution](../../execution-installation.md) still describes a macOS-only Host.

## Goal

Run the Host half of an execution installation on a Linux machine whose Dev container already runs under Docker. The coordinator and Host daemon become `systemd --user` services of the owner account. Every invariant of the macOS Host remains: guest-writable mount exclusion, digest-pinned artifacts, exact launcher binding, native process identity, owner-approved restarts and recoverable maintenance.

Repository policy currently authorizes only the macOS Host extension ([AGENTS.md](../../../AGENTS.md)). This slice adds inert source. The policy and installer documentation must be amended before any Linux Host is provisioned.

## Trust anchors

macOS relies on SIP-protected tool paths, Apple signing and kernel audit tokens. Linux substitutes:

- **Tools.** `busctl` and `systemctl` must be canonical root-owned files, with no group or other write bit on the file or any ancestor directory. The same rule will apply to `docker`.
- **User bus isolation.** The runtime directory must be canonical, private to the Host account and outside every writable guest mount, including ancestor and descendant overlaps. Same-UID guest processes defeat mode-bit protection if that directory is shared.
- **Service manager.** The authoritative user-manager PID is `MainPID` of `user@<uid>.service`, read from the system manager. The bus connection that owns `org.freedesktop.systemd1` on the user bus must belong to that PID. Each property read is addressed to that unique connection name, which the broker never reuses.
- **Exact launcher.** `ExecStart` is read as the typed D-Bus property `a(sasbttttuii)`. `systemctl show` joins argv with spaces without quoting, so it cannot bind arguments.
- **Process identity.** `/proc` must be procfs. The target must share the observer's PID and mount namespaces, so its executable path names the same file. The real, effective, saved and filesystem UIDs must all be the Host account. `startIdentity` is `/proc/<pid>/stat` field 22 converted with the kernel's `AT_CLKTCK`. It is boot-relative and compared only within one `boot_id`.
- **Absence.** A service is absent only when the user manager refuses the lookup with exactly `Unit <name> not loaded.`, or reports the unit `not-found` and `inactive`. This mirrors the macOS check of launchctl's exact message; a changed systemd message fails closed.
- **Service ownership.** This replaces macOS `parentPid === 1`. The process must be the unit's `MainPID`, its parent must be the authoritative user manager, and its only cgroup v2 entry must equal the unit's `ControlGroup` under `user@<uid>.service`. The unit must be `Type=simple` or `exec`, with `NotifyAccess=none` so no unit process can reassign `MainPID`.

The guest is not uid-distinct. Docker does not remap user IDs by default, and the image's `paseo` user is uid 1000 ([base image](../../../docker/base/Dockerfile)), the usual uid of the first account on a Linux machine. UID checks therefore never distinguish guest from Host processes. Namespace equality and the cgroup check do: container processes live under `system.slice/docker-*.scope` and cannot enter the delegated user-manager subtree.

Cgroup membership is not unforgeable against Host code. `user@<uid>.service` is delegated to the account, so any process already inside it may migrate into the coordinator's cgroup. `MainPID` and the parent check close that gap. Same-account Host code remains trusted, as on macOS, where any re-parented orphan also has parent PID 1.

Unlike root-owned launchd, `systemd --user` and the user bus broker run as the account itself. Their answers are trustworthy against the guest, which cannot reach `$XDG_RUNTIME_DIR`, but not against same-account Host code. Only the system manager's report of the user manager's PID comes from root.

## Host prerequisites

- 64-bit Linux with the unified cgroup v2 hierarchy.
- A `systemd --user` manager with a user D-Bus bus at `$XDG_RUNTIME_DIR/bus`. On Debian and Ubuntu that bus comes from `dbus-user-session`; `systemctl --user` works without it, but the reader does not.
- Lingering enabled for the account (`loginctl enable-linger`) on a headless Host, or the user manager and its services stop at logout.
- `/proc` mounted without `hidepid` or `subset`, and a kernel with `CONFIG_PROC_CHILDREN` for stopped-process child inventories.

## First slice checklist

- [x] **a. Platform-tagged Host service descriptor.** `InstallationConfigSchema.host` accepts either the existing `launchdService` or `systemdService: { kind: "systemd-user", uid, unit }`, never both. A Darwin Host rejects the systemd variant.
      Acceptance: every existing config parses unchanged, and macOS consumers keep reading `launchdService`. Verified by `config.test.ts` on Linux. Its Darwin case runs only on a Mac.
- [x] **b. `createSystemdBootstrapServiceReader()`.** Implements `BootstrapServiceReader`, `inspectRunningProcess`, `inspectStoppedProcess`, `verifyProcessExited` and `verifyServiceAbsent` over the pinned user-bus connection. `readService` returns a canonical JSON record. The pure parsers `systemdLoadedPid` and `isStoppedSystemdCandidate` mirror the launchd ones.
      Acceptance: `coordinator-bootstrap-systemd.test.ts` replays captured `busctl` output. It covers foreign-account, unvouched bus owner, changing manager, inactive manager, partial, mistyped, space-ambiguous argv, drop-in and pending-reload refusals, plus exact absence.
- [x] **c. `/proc` process inspector.** Produces the exact `ProcessObservationSchema` shape, with running, stopped (with child inventory) and exited modes. It re-reads before and after to detect exec or PID reuse and checks the requested running or stopped state on the final read.
      Acceptance: `coordinator-bootstrap-linux-process.test.ts` runs live against real PIDs: a spawned child, running and stopped states with child inventory, a reaped child through `verifyRetainedProcessExited`, a zombie, an exec under an unchanged birth, a thread ID, and another account's process when one exists.
- [x] **d. Ownership check.** `verifySystemdServiceOwnership` binds `MainPID`, the parent manager and the cgroup. It is Linux-only and is not yet called by the launchd consumers.
      Acceptance: fixture tests refuse a migrated process, a non-manager parent, a same-uid container cgroup, a unit cgroup outside the user manager, reassignable `MainPID` (`NotifyAccess`, `Type=forking`) and another account. `coordinator-bootstrap-systemd.local.e2e.test.ts` checks a transient user unit live, an outsider process and a same-uid process in another PID namespace.
- [x] **e. Tests.** Fixtures and live tests as above, stable across repeated runs on Node 24. The unit suites also pass on Node 22 inside a container whose PID 1 shares the test account's uid, as in the Dev container. The affected execution-installation suites pass on Linux, where their Darwin-only cases are skipped. CI's existing macOS leg also runs configuration and adapter contracts. The broader Darwin-only recovery suites still need a focused manual run on a Mac.

## Blockers found in this slice

- **No audit-token equivalent.** `inspectAuditedProcess` binds watchdog signals to one process lifetime with a Mach audit token, which is persisted in executor records (`BootstrapAuditedProcessSchema`). Linux has `pidfd_send_signal`, but a pidfd is a held descriptor, not a serializable token. Node exposes neither `pidfd_open` nor `pidfd_send_signal`. The Linux reader therefore leaves `inspectAuditedProcess` unimplemented. The watchdog and claimed recovery need a design that holds a pidfd across the signal, likely through a small pinned helper, before they can be ported. Signalling after re-checking `startIdentity` is racy and is not an acceptable substitute.
- **Consumers parse launchd text.** `verifyLoadedBootstrapService`, `verifyBootstrapReplacement` and `verifyBootstrapServiceIdentity` take a reader but parse launchctl output and check `parentPid === 1` themselves. Wiring needs a platform service-record strategy passed alongside the reader.
- **Protocol pins launchd.** `CoordinatorBootstrapPlanSchema.service` and `bootRecovery.service` accept only `gui/<uid>/…` labels. Linux plans need `systemd-user/<uid>/local.vorteo.<id>.installation.service` under the protocol compatibility rules.

## Pending

Not started. Each item needs its own review:

- Service-record strategy and wiring into `verifyLoadedBootstrapService` and `verifyBootstrapReplacement`
- Protocol extension for systemd plan services
- Launcher artifact: a pinned unit file, a parser and the "only approved paths change" rule (`verifyBootstrapLaunchers`)
- `systemctl --user restart` for owner-approved Host restarts (`daemon.ts`)
- Peer authentication for local IPC (`SO_PEERCRED`/pidfd) and the watchdog signal design above
- Kernel lock ownership verifier (`coordinator-bootstrap-ownership.ts`)
- Provisioning, unit generation, pairing and status tooling
- Claimed-executor recovery, renewal and repair chains, which must land before any Linux Host is installed
- Docker tool trust check, and a decision on the Host account's `docker` group membership, which is root-equivalent
- Policy and installer documentation amendments, then live acceptance

## Distribution and review follow-up

The server's normal TypeScript build includes both adapters under `dist/server/server/execution-installation`; the server package includes that directory. No new npm dependency, platform binary, configuration migration or user-run patch is needed for this foundation. The existing Linux live tests run in the server unit job on Linux; deterministic state-transition and writable-mount regression cases run on all CI platforms. The macOS job also checks the launchd-only configuration rule.

After this PR is merged, source installations must update to a revision containing it and run the normal build. Container installations must rebuild their image from that revision and follow the [existing deployment update procedure](../../docker.md). Managed Host and Dev installations use their [owner-approved source update workflow](../../host-handoff.md). A Git merge alone does not update installed runtimes, npm packages or desktop releases. Users of distributed packages receive the code when their chosen distribution publishes and installs a build containing the merge.

The adapters remain unselected. Installing this source does not enable Linux Host provisioning, systemd restarts or recovery, and does not change existing macOS Hosts. A minimal coordinator bundle includes only reachable runtime modules; inert adapters do not need to be forced into that closure until wiring makes them reachable. The pending work above remains required before claiming Linux Host support.

Review follow-up adds guest-mount exclusion for the trusted user runtime directory and rejects a final stopped, traced or exited process state after an initially running observation. Deterministic tests exercise the real inspection algorithm through a procfs read port, so signal timing does not make the race test flaky. Root README overview and onboarding remain unchanged because this is an inert foundation.
