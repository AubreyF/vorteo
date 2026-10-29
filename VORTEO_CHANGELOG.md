# Vorteo changelog

Vorteo change history, covering features, fixes, documentation, tests, tooling and upstream integration. Update this file in every commit using the prepared version and a dated entry. See the [commit workflow](docs/release.md#vorteo-release-notes).

The initial baseline is cumulative; older entries do not cover every maintenance commit. Historical version labels are preserved. Paseo release history remains in the [upstream changelog](CHANGELOG.md); the [customizations inventory](docs/vorteo-customizations.md) describes current fork capabilities and limitations.

## 0.11.0-beta.3.vorteo.921 - 2026-10-29

### Maintenance

- Integrate the reviewed stored Codex question projection while preserving core-services idle-close protection, provider-history recovery and local installation access. Unanswered questions remain visible after closure; native execution approvals are not restored.

## 0.11.0-beta.3.vorteo.916 - 2026-10-29

### Fixed

- A closed or stored Codex agent keeps its unanswered owner questions visible. Codex asks the owner questions asynchronously, and the agent records them in its saved session state, but once the agent was closed, listed from storage or reloaded, the manager and the stored projection showed no pending permissions at all, so the questions disappeared from the interface until the agent next ran. Both now read the unanswered questions back from the saved state, for Codex sessions only and never for native execution approvals, which are not restored. Resolved questions stay resolved. The change was written in the durable sessions phase 1 worktree by another thread and is shipped here unchanged apart from this entry.

### Validation

- Tests cover eight unanswered questions surviving a provider close and a resume on the same thread without a turn, remaining visible in the manager's closed projection and after a resume from persistence, staying in the stored and public projections while resolved ones drop out, holding back the automatic release of a queued message while a native approval is also pending, surviving the hosted session adapter's close and resume, and the parser accepting account provider aliases while rejecting other providers, malformed records and resolved state.

## 0.11.0-beta.3.vorteo.915 - 2026-10-29
