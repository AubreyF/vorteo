# Vorteo roadmap

Priorities below describe unfinished work. The [customizations inventory](vorteo-customizations.md) covers implemented features, including Codex goal controls, shared queues, account connectors, skill management and Host/Dev container coordination. Deployment and device acceptance remain installation-specific.

## Current priorities

- **Finish appearance delivery and acceptance.** The six-theme interface, Freed controls, floating sidebars and isolated browser demo have desktop and compact browser coverage. Complete source integration, guarded publication and installed owner review. Native font assets compile and embed, but iOS 27 startup currently stops before the interface renders; native typography, touch and Electron acceptance remain open. Validate blocked-goal recovery against the installed daemon and provider through the tracked update workflow. After appearance acceptance, conduct measured UI performance optimization and a comprehensive security review, then propose further improvements from those findings.

- **Complete quota reserve controls.** Connect the existing daemon policy to profile and task controls, capability checks and end-to-end acceptance. See [reserve integration](agent-presets.md#implementation-and-deployment-status).
- **Finish installation and workflow acceptance.** Verify native host setup, real account sign-in and tasks, supervisor/Pi delegation, skill availability, physical devices, dictation, accessibility and performance. Use the [host acceptance checklist](host-handoff.md#acceptance) and [execution guide](execution-installation.md); record remaining deployment work against actual installation evidence.
- **Deliver private desktop updates.** Automate custom-branch builds and updates for macOS, Windows and Linux. See the [desktop build proposal](desktop-auto-builds.md).

## Next capabilities

- **Recover installation services before login.** Future work, explicitly outside the current unattended-maintenance delivery. Evaluate system-level service registration, credential access and container startup before a user session exists. Current recovery acceptance begins after login with the container runtime available.

- **Broker service credentials.** Define environment identities and bounded grants, then implement a credential broker and first GitHub connector. Resolve operation scope, identity, key custody, revocation and recovery before implementation. See [environment grants](plans/execution-environments/environment-grants.md) and the [broker plan](plans/execution-environments/credential-broker.md).
- **Extend goals across providers.** Build on the existing Codex-native controls with durable objectives, checkpoints, completion evidence and reviewed handoffs across models. Coordinate budgets, queue delivery, quota admission and restart recovery through one continuation owner. Qualify Codex Secondary and Pi first, then other providers; do not run competing native and daemon continuation loops.
- **Expand execution isolation.** Evaluate task containers, Apple Container, folder grants and environment authorization as separately scoped projects. Keep credential, browser-trust and installation-recovery research in the [execution environment plans](plans/execution-environments/README.md#independent-future-projects).

## Keep pace with Paseo

Every upstream merge must compare incoming behavior with the [customizations inventory](vorteo-customizations.md#upstream-comparison), credit inherited features and revise these priorities. The integrated `0.11.0-beta.3` baseline already overlaps in usage visibility, provider configuration, mobile controls and skill deduplication. Preserve remaining custom behavior until implementation and tests establish parity; track any resulting retirement work here.
