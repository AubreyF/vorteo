# Team handoff and host migration

Keep an installation handoff outside Git. Include the current repository revision, active work, private deployment configuration, backed-up state, image references and verified acceptance evidence. Do not place credentials or machine-specific records in public documentation.

## Install or operate

For a new instance, follow the [container installer](../docker/multiplex/README.md). It builds locally on AMD64 or ARM64 and enrolls Tailscale inside the container. Connect provider accounts after installation. Optional macOS preview and recovery tools are separate from the standard installation.

For an existing instance, read its private handoff, [preset instructions](../skills/paseo/SKILL.md) and [development continuity](instance-continuity.md). Inspect the actual daemon and mounts before acting. For replacement or migration, follow [container operations](docker.md#existing-installations). An agent receiving only the repository needs the administrator's private handoff to operate an installed instance.

On the destination, read repository instructions and [agent presets](agent-presets.md). Inspect installed tools, model endpoints, provider identities and mounted state. A label or previous host's successful test is not evidence that the destination works.

Authenticate accounts independently and transfer private state only through a reviewed private process. Preserve existing services. Coordinate any interruption, take consistent backups and retain rollback artifacts. Verify Vorteo off/on behavior, actual model calls, bounded workers, private remote access, persistence and physical-device features. Do not automatically resume old schedules or interrupted tasks from a handoff document.

## Acceptance

Record pass, fail or not tested for each row, with the tested revision and private evidence. A source test does not establish live deployment acceptance.

- Identify the serving daemon, immutable image, mounted home, web receipt and entry scripts. Reconcile [source feature status](agent-presets.md#implementation-and-deployment-status) against this release.
- Authenticate distinct provider accounts and run a real model call. Configure agent-tool injection, launch a supervisor using its preset and verify a bounded worker uses the configured `profileId`. Check failure when required tools are unavailable.
- Compare Vorteo off and on. Saved accounts, profiles and running work must survive switching. Verify permission selection in the profile editor and Standard mode controls when off.
- Verify private HTTPS, password authentication, WebSocket continuity, intended-user access and denied-user access. Keep node identity and control state inaccessible to the agent user.
- For a native macOS host, complete the [desktop permission checks](execution-installation.md#macos-desktop-permissions) from an agent launched by its installed supervisor. Identify the responsible executable, verify screen capture and application control, or record desktop automation as intentionally unavailable. Recheck after runtime identity changes.
- If the optional preview broker is installed, start, repeat-start, stop and restart a preview. Verify its rendered application and stable frontend port. In a disposable instance or approved maintenance window, verify a daemon restart requires explicit preview start and does not undo a deliberate stop.
- Test home, credential and web persistence through disposable-container recreation. If installed, verify per-instance broker and recovery installation, rollback and removal preserve sibling instances. Test cold boot separately during an approved window.
- Follow the [touch audit](vorton-touch-audit.md) for physical iPhone/iPad keyboard, dictation, pinch zoom and Home Screen viewport checks. Capture accessibility and performance results for the actual served release.

Keep unresolved failures, their owner and the next verification step in the private handoff. Do not publish account inventories, URLs, logs or device receipts in this document.
