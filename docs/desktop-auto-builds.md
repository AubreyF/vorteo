# Automatic desktop builds and updates

Status: proposed, not implemented. Recorded September 16, 2026. This plan covers private desktop distribution from the custom branch; it does not authorize publishing releases or changing running installations. Existing release procedures remain in [release.md](release.md).

## Findings

- The embedded browser requires Electron. The [Electron pane](../packages/app/src/desktop/browser/pane/index.electron.tsx) implements it; the [web pane](../packages/app/src/desktop/browser/pane/index.web.tsx) displays an unavailable message. Install a desktop build of this branch to receive its custom interface.
- The [desktop workflow](../.github/workflows/desktop-release.yml) already builds multiple platforms. Adapt it instead of creating an unrelated release system. The desktop build exports the Electron renderer and packages the backend from source; publishing the private web export alone cannot update installed desktop renderers.
- The [builder configuration](../packages/desktop/electron-builder.yml) uses the Vorteo display name but retains the Paseo application identifiers and points updates at `getpaseo/paseo`. Separate the custom distribution before shipping it, or upstream updates could replace custom functionality.
- The [updater](../packages/desktop/src/features/auto-updater.ts) already downloads automatically. Vorteo validates updates before installing on quit; the AppImage path deliberately excludes quit-time installation because it can hang. Preserve that exception.
- The [desktop quit lifecycle](../packages/desktop/src/main.ts) can stop its managed daemon. Use independently managed remote hosts for ongoing agents when desktop updates must not interrupt work.

## Proposed architecture

Build an exact custom-branch commit after checks pass. Produce the renderer and bundled backend together, sign supported packages, run packaged smoke tests, then upload immutable artifacts and checksums. Publish the platform manifests only after every required build passes.

Use a private HTTPS endpoint reachable through Tailscale, subject to confirming workstation connectivity. Electron supports a generic HTTPS update provider. Keep client credentials out of the binary and scope build-worker publication credentials to the release destination. A disconnected client must continue running its installed version. A dedicated public GitHub Releases repository is an alternative if public binaries are acceptable. See [electron-builder's updater documentation](https://www.electron.build/v26/docs/features/auto-update/).

Give the custom distribution its own app identity, settings directory, installer name, and update feed. Audit deep links, shortcuts, Linux desktop entries, and local daemon discovery for coexistence with official Paseo. Keep custom interface behavior behind the existing Vorteo toggle.

Serialize publication and reject stale build promotion. Coalesce superseded builds before publication. Upload artifacts before switching manifests, retaining previous artifacts for recovery. Platform manifests share one release version and source commit. Clients download automatically and install at normal quit or explicit restart; AppImage uses explicit restart. Do not force a restart during active work.

Keep web and desktop publication separate, even when they use the same source revision. Follow [instance continuity](instance-continuity.md) for web delivery and [protocol compatibility](protocol-compatibility.md) when the desktop client and remote daemon differ in version.

## Initial platform scope

| Platform | Packages and architectures                                                    | Prerequisites and behavior                                                                  |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| macOS    | DMG for initial installation, ZIP for updates; Apple Silicon, Intel if needed | Developer ID signing and notarization; signed apps are required for macOS automatic updates |
| Windows  | NSIS installer; x64 initially                                                 | Select and provision Windows code signing; validate installed updates                       |
| Linux    | AppImage; x64 initially                                                       | Preserve stable filenames and explicit restart installation                                 |

Confirm the actual workstation architectures before implementation. Add Windows ARM64, Linux ARM64, and DEB/RPM distribution only when required. Keep machine inventories, credential state, endpoint addresses, and acceptance receipts outside Git under [publication hygiene](publication-hygiene.md).

## Versioning

The selected scheme is `<upstream-base>-vorton.<counter>`, incremented for every commit. [Vorteo commit versions](release.md#vorton-commit-versions) owns the workflow and synchronization rules. This replaces the earlier open question about Freed-style numbering.

Desktop distribution still needs its separate app identity and private feed, explicit prerelease channel handling, and a packaged update test. Recover by packaging known-good code under a higher version; do not rely on automatic downgrades.

## To-do and acceptance

- [ ] Confirm target architectures, private feed access, signing methods, and packaged version compatibility.
- [ ] Separate app identity, local state, update feed, and platform integrations from official Paseo.
- [ ] Ship one signed and notarized Mac build to a second workstation connected to an existing independent host.
- [ ] Prove a real Mac update from release A to release B before adding other platforms.
- [ ] Extend the pipeline to Windows NSIS and Linux AppImage with packaged smoke tests.
- [ ] Implement immutable uploads, publication serialization, complete manifests, and stale-build rejection.
- [ ] On each supported platform, install A, publish B, verify automatic download and installation, check version and source revision, preserve settings, and confirm remote agents remain running.
- [ ] Test interrupted downloads, unavailable feeds, recovery releases, and local daemon ownership during quit and restart.
- [ ] For interface changes, verify shared settings and environment selection, then publish the tested private web export. Obtain physical-device acceptance where emulation cannot establish behavior; never launch macOS Playwright WebKit.
- [ ] Record private installation and recovery instructions, then enable unattended publication after acceptance and authorization.

## Estimated effort

| Work                                                               | Engineering days |
| ------------------------------------------------------------------ | ---------------- |
| Shared identity, versioning, and daemon ownership audit            | 1                |
| macOS signing, notarization, and packaging                         | 1 to 1.5         |
| Windows signing and installer integration                          | 1 to 1.5         |
| Linux AppImage packaging and update behavior                       | 0.5 to 1         |
| Build matrix, hosting, and coordinated publication                 | 1 to 1.5         |
| Cross-platform update tests, initial installs, and operating notes | 2.5 to 3.5       |
| Total                                                              | 7 to 10          |

The Mac-only milestone was estimated at 4 to 6 engineering days. These estimates assume clean builds, available signing credentials, representative test machines, and reuse of the existing updater. Allow another 2 to 4 days for cross-platform packaging, signing, or behavior repairs. Certificate procurement, human review, device access, and approval waits add calendar time. These are planning estimates, not measured coding-agent runtimes or delivery commitments.
