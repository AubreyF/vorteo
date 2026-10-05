# Documentation index

Use this index to find the document that owns your task. Read relevant subjects before editing; planned work lives in the roadmap. Agent entry points: [repository rules](../AGENTS.md), [app rules](../packages/app/AGENTS.md), and [writing rules](writing.md).

| Doc                                                                   | What's in it                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [docs/roadmap.md](roadmap.md)                                         | Planned fork work, separate from shipped capabilities                                                                          |
| [Execution environment plans](plans/execution-environments/README.md) | Proposed two-day unified host/container installation and separately scoped future projects                                     |
| [docs/product.md](product.md)                                         | What Vorteo is, who it's for, where it's going                                                                                 |
| [docs/architecture.md](architecture.md)                               | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                |
| [docs/agent-lifecycle.md](agent-lifecycle.md)                         | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                  |
| [docs/data-model.md](data-model.md)                                   | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                         |
| [docs/glossary.md](glossary.md)                                       | Authoritative terminology — UI label wins, no synonyms                                                                         |
| [docs/coding-standards.md](coding-standards.md)                       | Type hygiene, error handling, state design, React patterns, file organization                                                  |
| [docs/design.md](design.md)                                           | Design system — tokens, buttons, hierarchy, density, alignment rails, states, what's forbidden                                 |
| [docs/forms.md](forms.md)                                             | Form architecture — non-React form model, form kit, load-state gating; the schedule form is the golden example                 |
| [docs/hover.md](hover.md)                                             | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it |
| [docs/unistyles.md](unistyles.md)                                     | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                       |
| [docs/floating-panels.md](floating-panels.md)                         | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash      |
| [docs/menus.md](menus.md)                                             | The menu engine — popover vs sheet, submenu pages, hover intent, when a decision earns a submenu                               |
| [docs/expo-router.md](expo-router.md)                                 | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                  |
| [docs/file-icons.md](file-icons.md)                                   | Material icon theme integration for the file explorer                                                                          |
| [docs/providers.md](providers.md)                                     | Adding a new agent provider end-to-end                                                                                         |
| [docs/forge-providers.md](forge-providers.md)                         | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                  |
| [docs/custom-providers.md](custom-providers.md)                       | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                              |
| [docs/plugins.md](plugins.md)                                         | Local plugin manifest, directory source config, RPCs, native surfaces, and attachment sources                                  |
| [docs/service-proxy.md](service-proxy.md)                             | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                      |
| [docs/development.md](development.md)                                 | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                     |
| [docs/rpc-namespacing.md](rpc-namespacing.md)                         | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                           |
| [docs/protocol-compatibility.md](protocol-compatibility.md)           | Why app/daemon versions drift, protocol vs feature contract, capability gating, COMPAT tagging                                 |
| [docs/protocol-validation.md](protocol-validation.md)                 | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                              |
| [docs/permissions.md](permissions.md)                                 | Semantic daemon permissions, principals, credentials, pairing invitations, and Hub authority                                   |
| [docs/terminal-performance.md](terminal-performance.md)               | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                     |
| [docs/agent-stream-performance.md](agent-stream-performance.md)       | Assistant text pipeline — coalescing window, paced reveal, why arrival lumps are smoothed at render                            |
| [docs/file-observation.md](file-observation.md)                       | Recursive watcher ownership, Linux constraints, teardown invariants, and Parcel comparison                                     |
| [docs/testing.md](testing.md)                                         | TDD workflow, determinism, real dependencies over mocks, test organization                                                     |
| [docs/qa.md](qa.md)                                                   | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                      |
| [docs/mobile-testing.md](mobile-testing.md)                           | Maestro and mobile test workflows                                                                                              |
| [docs/mobile-panels.md](mobile-panels.md)                             | Compact left/center/right panel ownership, worklet motion, gesture revisions, and Fabric constraints                           |
| [docs/explorer-sidebar.md](explorer-sidebar.md)                       | Explorer sidebar and ordinary side-pane host contracts, lifecycle, placement, and routing preferences                          |
| [docs/ad-hoc-daemon-testing.md](ad-hoc-daemon-testing.md)             | Isolated in-process daemon test harness                                                                                        |
| [docs/browser-capture-harness.md](browser-capture-harness.md)         | Real-Electron browser screenshot harness and compositor-surface gotcha                                                         |
| [docs/android.md](android.md)                                         | App variants, local/cloud builds, EAS workflows, version codes, F-Droid source builds and store metadata                       |
| [docs/docker.md](docker.md)                                           | Running the daemon and bundled web UI in Docker, volumes, agent images, security                                               |
| [docs/container-tailscale.md](container-tailscale.md)                 | Reusable single-container Tailscale architecture and private installation boundaries                                           |
| [docs/private-domain.md](private-domain.md)                           | Optional custom-domain gateway: private Tailscale endpoint, Caddy templates, DNS, verification and removal                     |
| [docs/host-handoff.md](host-handoff.md)                               | Team handoff entry point, fresh installation, migration and acceptance                                                         |
| [docs/instance-continuity.md](instance-continuity.md)                 | Persistent web publication and active-instance development                                                                     |
| [docs/agent-presets.md](agent-presets.md)                             | Saved presets, managed workers, quota lifecycle and implementation status                                                      |
| [docs/vorton-touch-audit.md](vorton-touch-audit.md)                   | Vorteo touch contract, historical checks and physical-device limits                                                            |
| [docs/publication-hygiene.md](publication-hygiene.md)                 | Public source boundaries, secret checks and history cleanup                                                                    |
| [docs/release.md](release.md)                                         | Release playbook, draft releases, completion checklist                                                                         |
| [docs/desktop-auto-builds.md](desktop-auto-builds.md)                 | Proposed private desktop build and update pipeline, findings, acceptance work, and effort estimate                             |
| [docs/terminal-activity.md](terminal-activity.md)                     | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                       |
| [SECURITY.md](../SECURITY.md)                                         | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                  |
| [public-docs/hub/security.md](../public-docs/hub/security.md)         | Public Hub guide — trust boundaries, untrusted triggers, provider controls, and output authority                               |

Host and container setup, trust boundaries, restart requests and removal: [Host and container execution](execution-installation.md).

- [Skill library](skill-library.md): inventory, ownership, reviewed changes, and profile selection.
